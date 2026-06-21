// ══════════════════════════════════════════════════════
//  api/escrow-action.js  —  Vercel Serverless Function
//  Admin-only. Moves a HELD escrow transaction to its final
//  state once the vehicle handoff is confirmed (or a problem
//  is reported).
//
//  action: 'release'  → admin confirms handoff went fine. Marks
//                        the row 'released'. The listing's commission
//                        rate (set at approval time) is applied to the
//                        escrow amount and recorded as already
//                        collected — since the buyer paid into escrow,
//                        the broker's cut comes off the top before
//                        the remainder is paid to the seller manually
//                        (bank/Telebirr). Automatic payout via Chapa's
//                        Transfers API is a future enhancement, not
//                        built here — the admin still has to send the
//                        seller's portion themselves; this endpoint
//                        just tells them how much that portion is.
//  action: 'refund'   → admin manually refunds the buyer via Chapa
//                        dashboard, then marks the row 'refunded'
//                        here for the record. No commission applies —
//                        nothing was sold.
//  action: 'dispute'  → either side reported a problem. Marks the
//                        row 'disputed' with a note, pending review.
//                        Does not move money by itself.
//
//  This never moves money itself — Chapa payouts/refunds for now
//  happen from the Chapa merchant dashboard, and this endpoint is
//  the system-of-record for what was decided and why.
//
//  Env vars needed: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ══════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const VALID_ACTIONS = ["release", "refund", "dispute"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const { txRef, action, note, accessToken } = req.body ?? {};

    if (!txRef || !action || !accessToken)
      return res.status(400).json({ error: "txRef, action and accessToken are required" });

    if (!VALID_ACTIONS.includes(action))
      return res.status(400).json({ error: `action must be one of: ${VALID_ACTIONS.join(", ")}` });

    // ── Verify the caller is logged in AND is an admin ──
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(accessToken);
    if (userErr || !userData?.user)
      return res.status(401).json({ error: "Not authenticated" });

    const { data: adminRow } = await supabaseAdmin
      .from("admins")
      .select("user_id")
      .eq("user_id", userData.user.id)
      .single();

    if (!adminRow)
      return res.status(403).json({ error: "Admin access required" });

    // ── Load the escrow row ──
    const { data: escrow, error: escrowErr } = await supabaseAdmin
      .from("escrow_transactions")
      .select("*")
      .eq("tx_ref", txRef)
      .single();

    if (escrowErr || !escrow)
      return res.status(404).json({ error: "Escrow transaction not found" });

    // ── State machine guard: only HELD transactions can be acted on ──
    // (a 'disputed' one can still be released or refunded once resolved)
    if (!["held", "disputed"].includes(escrow.status))
      return res.status(400).json({
        error: `Cannot ${action} a transaction in status '${escrow.status}'`,
      });

    if (action === "dispute") {
      if (!note)
        return res.status(400).json({ error: "note is required when filing a dispute" });

      // Prevent silently overwriting an existing dispute note.
      if (escrow.status === "disputed")
        return res.status(400).json({ error: "Transaction is already disputed" });

      const { error: updErr } = await supabaseAdmin
        .from("escrow_transactions")
        .update({ status: "disputed", dispute_note: note })
        .eq("tx_ref", txRef);
      if (updErr) throw updErr;

      return res.status(200).json({ ok: true, status: "disputed" });
    }

    const newStatus = action === "release" ? "released" : "refunded";

    let payoutInfo = null;

    if (action === "release") {
      // ── Look up the listing's commission rate (set by the admin
      //    at approval time) and apply it to the escrow amount. ──
      const { data: listing, error: listingErr } = await supabaseAdmin
        .from("listings")
        .select("id, commission_percent, status")
        .eq("id", escrow.listing_id)
        .single();

      if (listingErr || !listing)
        return res.status(404).json({ error: "Linked listing not found — cannot compute commission" });

      if (listing.commission_percent == null)
        return res.status(400).json({
          error: "This listing has no commission rate on record. Re-approve it in Pending Listings (or All Listings, once re-opened) to set one before releasing escrow.",
        });

      const commissionPct = Number(listing.commission_percent);
      const commissionDeducted = Math.round((escrow.amount * commissionPct / 100) * 100) / 100;
      const sellerPayout = Math.round((escrow.amount - commissionDeducted) * 100) / 100;

      const { error: escrowUpdErr } = await supabaseAdmin
        .from("escrow_transactions")
        .update({
          status: newStatus,
          resolution_note: note || null,
          resolved_by: userData.user.id,
          resolved_at: new Date().toISOString(),
          commission_deducted: commissionDeducted,
        })
        .eq("tx_ref", txRef);
      if (escrowUpdErr) throw escrowUpdErr;

      // Only mark the listing sold/commission-collected if it isn't
      // already (e.g. admin somehow released the same escrow twice —
      // state machine guard above already prevents that, but this
      // keeps a re-released disputed transaction from double-marking).
      if (listing.status !== "sold") {
        const { error: listingUpdErr } = await supabaseAdmin
          .from("listings")
          .update({
            status: "sold",
            sold_at: new Date().toISOString(),
            sold_by: userData.user.id,
            sale_price: escrow.amount,
            commission_owed: commissionDeducted,
            commission_status: "collected",
            commission_note: `Deducted from escrow payout (tx_ref ${txRef})`,
          })
          .eq("id", listing.id);
        if (listingUpdErr) throw listingUpdErr;
      }

      payoutInfo = {
        escrowAmount: escrow.amount,
        commissionPercent: commissionPct,
        commissionDeducted,
        sellerPayout,
      };

      return res.status(200).json({ ok: true, status: newStatus, payout: payoutInfo });
    }

    const { error: updErr } = await supabaseAdmin
      .from("escrow_transactions")
      .update({
        status: newStatus,
        resolution_note: note || null,
        resolved_by: userData.user.id,
        resolved_at: new Date().toISOString(),
      })
      .eq("tx_ref", txRef);
    if (updErr) throw updErr;

    return res.status(200).json({ ok: true, status: newStatus });
  } catch (error) {
    console.error("escrow-action error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
