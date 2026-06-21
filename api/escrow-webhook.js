// ══════════════════════════════════════════════════════
//  api/escrow-webhook.js  —  Vercel Serverless Function
//  Chapa calls this when the buyer completes an escrow payment.
//  Same signature-verify + re-verify pattern as
//  api/payment-webhook.js — never trust the webhook body alone.
//  On success this only ever moves a row from 'pending' to 'held'.
//  Nothing is released to the seller here — that's a separate,
//  admin-only step (api/escrow-action.js) after the handoff is
//  confirmed.
//
//  Env vars needed: CHAPA_SECRET_KEY, CHAPA_WEBHOOK_SECRET,
//  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ══════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  api: { bodyParser: false },
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
    console.warn("Escrow webhook signature mismatch — ignoring.");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = JSON.parse(rawBody);
  const { tx_ref } = event;
  if (!tx_ref) return res.status(400).json({ error: "Missing tx_ref" });

  // Only handle escrow transactions here — ordinary "featured listing"
  // payments use the same Chapa account but go through
  // api/payment-webhook.js instead, keyed off the tx_ref prefix.
  if (!tx_ref.startsWith("bbescrow_"))
    return res.status(200).json({ ok: true, skipped: true });

  try {
    // ── 2. Re-verify directly against Chapa's API ──
    const verifyRes = await fetch(
      `https://api.chapa.co/v1/transaction/verify/${tx_ref}`,
      { headers: { Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}` } }
    );
    const verifyData = await verifyRes.json();

    const reallyPaid = verifyRes.ok && verifyData.status === "success" &&
      verifyData.data?.status === "success";

    // ── 3. Look up the pending escrow record ──
    const { data: escrow, error: escrowErr } = await supabaseAdmin
      .from("escrow_transactions")
      .select("*")
      .eq("tx_ref", tx_ref)
      .single();

    if (escrowErr || !escrow) {
      console.error("Escrow webhook for unknown tx_ref:", tx_ref);
      return res.status(404).json({ error: "Unknown escrow transaction" });
    }

    if (escrow.status !== "pending") {
      // Already processed or already moved on (e.g. held/disputed) —
      // acknowledge and stop, Chapa may retry webhooks.
      return res.status(200).json({ ok: true, alreadyProcessed: true });
    }

    if (!reallyPaid) {
      await supabaseAdmin.from("escrow_transactions")
        .update({ status: "cancelled" })
        .eq("tx_ref", tx_ref);
      return res.status(200).json({ ok: true, applied: false });
    }

    // ── 4. Funds are confirmed paid in — mark HELD, not released ──
    await supabaseAdmin.from("escrow_transactions")
      .update({
        status: "held",
        chapa_ref_id: verifyData.data?.reference || null,
        method: verifyData.data?.method || null,
        held_at: new Date().toISOString(),
      })
      .eq("tx_ref", tx_ref);

    return res.status(200).json({ ok: true, applied: true });
  } catch (error) {
    console.error("escrow-webhook error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
