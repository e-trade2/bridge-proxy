// ══════════════════════════════════════════════════════
//  api/payout.js  —  Vercel Serverless Function
//  Admin-only. Called immediately after escrow-action
//  releases funds. Uses Chapa's Transfer API to send the
//  seller's cut (escrow amount minus commission) directly
//  to their registered bank account.
//
//  Flow:
//  1. Admin clicks "Release & Pay" in admin.html
//  2. admin.html calls /api/escrow-action (release) first
//  3. On success, admin.html calls this endpoint
//  4. This endpoint reads the seller's bank details from
//     the sellers table and fires a Chapa transfer
//  5. Records the transfer reference on the escrow row
//
//  Chapa Transfer API notes:
//  - Requires sufficient balance in your Chapa account
//  - Transfers happen Mon–Sat 08:30–16:30 Ethiopian time
//    (queued outside those hours, executed when window opens)
//  - Bank list / codes: GET /api/banks (proxied from Chapa)
//
//  Env vars needed:
//    CHAPA_SECRET_KEY, ALLOWED_ORIGIN,
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ══════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "null";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const { txRef, accessToken } = req.body ?? {};

    if (!txRef || !accessToken)
      return res.status(400).json({ error: "txRef and accessToken are required" });

    // ── 1. Verify admin ──
    const { data: userData, error: userErr } =
      await supabaseAdmin.auth.getUser(accessToken);
    if (userErr || !userData?.user)
      return res.status(401).json({ error: "Not authenticated" });

    const { data: adminRow } = await supabaseAdmin
      .from("admins")
      .select("user_id")
      .eq("user_id", userData.user.id)
      .single();

    if (!adminRow)
      return res.status(403).json({ error: "Admin access required" });

    // ── 2. Load the escrow row — must be in 'released' status ──
    const { data: escrow, error: escrowErr } = await supabaseAdmin
      .from("escrow_transactions")
      .select("*")
      .eq("tx_ref", txRef)
      .single();

    if (escrowErr || !escrow)
      return res.status(404).json({ error: "Escrow transaction not found" });

    if (escrow.status !== "released")
      return res.status(400).json({
        error: `Escrow must be in 'released' status to pay out. Current status: '${escrow.status}'. Run escrow-action release first.`,
      });

    if (escrow.payout_transfer_ref) {
      // Already paid out — idempotency guard
      return res.status(200).json({
        ok: true,
        alreadyPaid: true,
        transferRef: escrow.payout_transfer_ref,
      });
    }

    // ── 3. Compute the payout amount (what escrow-action already stored) ──
    const commissionDeducted = Number(escrow.commission_deducted ?? 0);
    const sellerPayout = Math.round((escrow.amount - commissionDeducted) * 100) / 100;

    if (sellerPayout <= 0)
      return res.status(400).json({
        error: `Seller payout is ${sellerPayout} ETB — nothing to transfer.`,
      });

    // ── 4. Load the seller's bank details ──
    const { data: seller, error: sellerErr } = await supabaseAdmin
      .from("sellers")
      .select("display_name, bank_account_name, bank_account_number, bank_code")
      .eq("user_id", escrow.seller_id)
      .single();

    if (sellerErr || !seller)
      return res.status(404).json({ error: "Seller profile not found" });

    if (!seller.bank_account_number || !seller.bank_code || !seller.bank_account_name) {
      return res.status(400).json({
        error: "Seller has not added their bank details yet. Ask them to go to Seller Dashboard → Bank Details and fill in their account info before you release.",
      });
    }

    // ── 5. Fire the Chapa transfer ──
    const transferRef = `bbpayout_${txRef}_${Date.now()}`;

    const chapaRes = await fetch("https://api.chapa.co/v1/transfers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        account_name:   seller.bank_account_name,
        account_number: seller.bank_account_number,
        amount:         String(sellerPayout),
        currency:       "ETB",
        reference:      transferRef,
        bank_code:      seller.bank_code,
      }),
    });

    const chapaData = await chapaRes.json();

    if (!chapaRes.ok || chapaData.status !== "success") {
      console.error("Chapa transfer error:", JSON.stringify(chapaData));
      return res.status(502).json({
        error: chapaData.message || "Chapa transfer failed",
        detail: chapaData,
      });
    }

    // ── 6. Record the transfer reference on the escrow row ──
    await supabaseAdmin
      .from("escrow_transactions")
      .update({
        payout_transfer_ref:    transferRef,
        payout_transfer_status: "queued",
        payout_at:              new Date().toISOString(),
        payout_amount:          sellerPayout,
      })
      .eq("tx_ref", txRef);

    return res.status(200).json({
      ok: true,
      transferRef,
      sellerPayout,
      message: chapaData.message || "Transfer queued successfully",
    });

  } catch (error) {
    console.error("payout.js error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
