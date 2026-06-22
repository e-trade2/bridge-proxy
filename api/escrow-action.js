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

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "null"; // fails closed — set ALLOWED_ORIGIN in Vercel to your real domain (e.g. https://www.bridge-broker.com)

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
        .update({
          status: "disputed",
          dispute_note: note,
          disputed_by: userData.user.id,
          disputed_at: new Date().toISOString(),
        })
        .eq("tx_ref", txRef);
      if (updErr) throw updErr;

      return res.status(200).json({ ok: true, status: "disputed" });
    }

    if (action === "release") {
      // ── Atomic release via DB function (prevents double-release race) ──
      // release_escrow() uses SELECT … FOR UPDATE to lock the row, then
      // checks the status again inside the transaction. If two admin
      // sessions both call "release" simultaneously, one gets 'ok' and
      // the other gets 'conflict' — the second call updates 0 rows and
      // returns early instead of creating a second commission deduction
      // or marking the listing sold a second time.
      // See sql/setup_fixes.sql for the full function definition.
      const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc(
        "release_escrow",
        {
          p_tx_ref:          txRef,
          p_resolved_by:     userData.user.id,
          p_resolution_note: note || null,
        }
      );
      if (rpcErr) throw rpcErr;

      if (rpcResult.result === "not_found")
        return res.status(404).json({ error: "Escrow transaction not found" });

      if (rpcResult.result === "conflict")
        return res.status(409).json({
          error: "This escrow was already released by another session. Refresh and try again.",
        });

      if (rpcResult.result === "wrong_status")
        return res.status(400).json({
          error: `Cannot release a transaction in status '${rpcResult.status}'`,
        });

      return res.status(200).json({
        ok: true,
        status: "released",
        payout: {
          escrowAmount:       rpcResult.escrow_amount,
          commissionPercent:  rpcResult.commission_percent,
          commissionDeducted: rpcResult.commission_deducted,
          sellerPayout:       rpcResult.seller_payout,
        },
      });
    }

    // action === "refund"
    const { error: updErr } = await supabaseAdmin
      .from("escrow_transactions")
      .update({
        status: "refunded",
        resolution_note: note || null,
        resolved_by: userData.user.id,
        resolved_at: new Date().toISOString(),
      })
      .eq("tx_ref", txRef);
    if (updErr) throw updErr;

    return res.status(200).json({ ok: true, status: "refunded" });
  } catch (error) {
    console.error("escrow-action error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
