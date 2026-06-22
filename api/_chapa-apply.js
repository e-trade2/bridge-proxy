// ══════════════════════════════════════════════════════
//  api/_chapa-apply.js  —  Shared helper, not a route
//  (leading underscore: Vercel does not deploy this as an endpoint)
//
//  Chapa only supports ONE webhook URL per merchant account under
//  standard webhooks. This app has two payment flows — featured-
//  listing payments (api/payment-webhook.js) and escrow
//  (api/escrow-webhook.js) — each with its own callback_url, but
//  only one of those two URLs can actually be registered as THE
//  webhook in the Chapa Dashboard.
//
//  To make that not matter, both api/payment-webhook.js and
//  api/escrow-webhook.js call into the SAME pair of apply* functions
//  below after verifying the request (signature on POST, or just a
//  trigger-to-verify on GET). Whichever of the two URLs you register
//  as the dashboard webhook, it will correctly process BOTH payment
//  types — it dispatches by the tx_ref prefix ("bbescrow_" vs "bb_"),
//  not by which file happened to receive the request.
//
//  Each function re-verifies directly against Chapa's API before
//  applying anything — never trusts the caller's tx_ref/payload
//  alone. Each is idempotent (checks current status before writing)
//  so it's safe to call from both the GET callback path and the
//  POST webhook path without double-applying.
// ══════════════════════════════════════════════════════

/**
 * Apply a featured-listing payment if Chapa confirms it actually paid.
 * Returns { handled: false } if tx_ref isn't a payments-table tx_ref
 * (e.g. it's an escrow tx_ref — caller should try applyEscrow instead).
 */
export async function applyPayment(supabaseAdmin, tx_ref) {
  if (tx_ref.startsWith("bbescrow_")) return { handled: false };

  const { data: payment, error: payErr } = await supabaseAdmin
    .from("payments")
    .select("*")
    .eq("tx_ref", tx_ref)
    .single();

  if (payErr || !payment) return { handled: true, ok: false, error: "Unknown transaction", status: 404 };

  if (payment.status === "completed") {
    return { handled: true, ok: true, alreadyProcessed: true };
  }

  const verifyRes = await fetch(
    `https://api.chapa.co/v1/transaction/verify/${tx_ref}`,
    { headers: { Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}` } }
  );
  const verifyData = await verifyRes.json();

  const reallyPaid = verifyRes.ok && verifyData.status === "success" &&
    verifyData.data?.status === "success";

  if (!reallyPaid) {
    await supabaseAdmin.from("payments")
      .update({ status: "failed" })
      .eq("tx_ref", tx_ref);
    return { handled: true, ok: true, applied: false };
  }

  // Mark payment completed first. We write `payments` before updating
  // `listings` so that if the process crashes between the two writes,
  // the next retry finds status='completed' and exits early above
  // (idempotency guard), preventing a double-application of the
  // featured window. Safest ordering available without a true DB
  // transaction.
  await supabaseAdmin.from("payments")
    .update({
      status: "completed",
      chapa_ref_id: verifyData.data?.reference || null,
      method: verifyData.data?.method || null,
      completed_at: new Date().toISOString(),
    })
    .eq("tx_ref", tx_ref);

  if (payment.plan === "featured_1week" || payment.plan === "featured_4weeks") {
    const weeks = payment.plan === "featured_4weeks" ? 4 : 1;
    const addMs = weeks * 7 * 24 * 60 * 60 * 1000;

    // Extend from the existing expiry if the listing is already featured
    // and that expiry is still in the future — so a seller who renews
    // early doesn't lose the remaining time from their current window.
    const { data: currentListing } = await supabaseAdmin
      .from("listings")
      .select("featured, featured_expires_at")
      .eq("id", payment.listing_id)
      .single();

    const baseDate =
      currentListing?.featured &&
      currentListing?.featured_expires_at &&
      new Date(currentListing.featured_expires_at) > new Date()
        ? new Date(currentListing.featured_expires_at)
        : new Date();

    const expiresAt = new Date(baseDate.getTime() + addMs);

    await supabaseAdmin.from("listings")
      .update({ featured: true, featured_expires_at: expiresAt.toISOString() })
      .eq("id", payment.listing_id);
  }

  return { handled: true, ok: true, applied: true };
}

/**
 * Apply an escrow payment (moves it from 'pending' to 'held') if
 * Chapa confirms it actually paid. Returns { handled: false } if
 * tx_ref isn't an escrow tx_ref.
 */
export async function applyEscrow(supabaseAdmin, tx_ref) {
  if (!tx_ref.startsWith("bbescrow_")) return { handled: false };

  const { data: escrow, error: escrowErr } = await supabaseAdmin
    .from("escrow_transactions")
    .select("*")
    .eq("tx_ref", tx_ref)
    .single();

  if (escrowErr || !escrow) return { handled: true, ok: false, error: "Unknown escrow transaction", status: 404 };

  if (escrow.status !== "pending") {
    // Already processed or already moved on (e.g. held/disputed) —
    // acknowledge and stop, Chapa may retry.
    return { handled: true, ok: true, alreadyProcessed: true };
  }

  const verifyRes = await fetch(
    `https://api.chapa.co/v1/transaction/verify/${tx_ref}`,
    { headers: { Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}` } }
  );
  const verifyData = await verifyRes.json();

  const reallyPaid = verifyRes.ok && verifyData.status === "success" &&
    verifyData.data?.status === "success";

  if (!reallyPaid) {
    await supabaseAdmin.from("escrow_transactions")
      .update({ status: "cancelled" })
      .eq("tx_ref", tx_ref);
    return { handled: true, ok: true, applied: false };
  }

  // Funds are confirmed paid in — mark HELD, not released. Release is
  // a separate, admin-only step (api/escrow-action.js) after the
  // physical handoff is confirmed.
  await supabaseAdmin.from("escrow_transactions")
    .update({
      status: "held",
      chapa_ref_id: verifyData.data?.reference || null,
      method: verifyData.data?.method || null,
      held_at: new Date().toISOString(),
    })
    .eq("tx_ref", tx_ref);

  return { handled: true, ok: true, applied: true };
}
