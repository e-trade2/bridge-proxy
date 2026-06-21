// ══════════════════════════════════════════════════════
//  api/payment-webhook.js  —  Vercel Serverless Function
//  Chapa calls this automatically when a payment succeeds.
//  We NEVER trust the webhook body alone — we verify the
//  signature, then re-verify the transaction directly against
//  Chapa's API before applying anything (e.g. marking a
//  listing featured). This stops anyone from forging a
//  webhook call to get a free featured listing.
//
//  Env vars needed (same Vercel project as payment-init.js):
//    CHAPA_SECRET_KEY, CHAPA_WEBHOOK_SECRET,
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ══════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  api: { bodyParser: false }, // we need the raw body to verify the signature
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await readRawBody(req);

  // ── 1. Verify this really came from Chapa ──
  const expectedSig = crypto
    .createHmac("sha256", process.env.CHAPA_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  const receivedSig = req.headers["x-chapa-signature"];
  if (!receivedSig || receivedSig !== expectedSig) {
    console.warn("Webhook signature mismatch — ignoring.");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = JSON.parse(rawBody);
  const { tx_ref, status } = event;

  if (!tx_ref) return res.status(400).json({ error: "Missing tx_ref" });

  try {
    // ── 2. Re-verify directly against Chapa's API — never trust ──
    //      the webhook payload alone, in case it was replayed/altered.
    const verifyRes = await fetch(
      `https://api.chapa.co/v1/transaction/verify/${tx_ref}`,
      { headers: { Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}` } }
    );
    const verifyData = await verifyRes.json();

    const reallyPaid = verifyRes.ok && verifyData.status === "success" &&
      verifyData.data?.status === "success";

    // ── 3. Look up our pending payment record ──
    const { data: payment, error: payErr } = await supabaseAdmin
      .from("payments")
      .select("*")
      .eq("tx_ref", tx_ref)
      .single();

    if (payErr || !payment) {
      console.error("Webhook for unknown tx_ref:", tx_ref);
      return res.status(404).json({ error: "Unknown transaction" });
    }

    if (payment.status === "completed") {
      // Already processed (Chapa may retry webhooks) — acknowledge and stop.
      return res.status(200).json({ ok: true, alreadyProcessed: true });
    }

    if (!reallyPaid) {
      await supabaseAdmin.from("payments")
        .update({ status: "failed" })
        .eq("tx_ref", tx_ref);
      return res.status(200).json({ ok: true, applied: false });
    }

    // ── 4. Mark payment completed first ──
    // We write `payments` before updating `listings` so that if the
    // process crashes between the two writes, the next webhook retry
    // finds status='completed' and exits early (idempotency guard at
    // the top of this function), preventing a double-application of
    // the featured window. This is the safest ordering available
    // without a true database transaction.
    await supabaseAdmin.from("payments")
      .update({
        status: "completed",
        chapa_ref_id: verifyData.data?.reference || null,
        method: verifyData.data?.method || null,
        completed_at: new Date().toISOString(),
      })
      .eq("tx_ref", tx_ref);

    // ── 5. Apply the effect of payment ──
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

    return res.status(200).json({ ok: true, applied: true });
  } catch (error) {
    console.error("payment-webhook error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
