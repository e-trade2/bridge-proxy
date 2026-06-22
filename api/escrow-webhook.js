// ══════════════════════════════════════════════════════
//  api/escrow-webhook.js  —  Vercel Serverless Function
//
//  Handles Chapa escrow payment notifications via TWO mechanisms:
//
//  1. callback_url (set per-transaction in escrow-init.js)
//     Chapa sends a GET here with ?trx_ref=...&status=...
//     No signature — treated as an untrusted nudge only.
//
//  2. Dashboard webhook — only fires here if you've registered
//     THIS URL in the Chapa Dashboard instead of (or in addition
//     to) api/payment-webhook. Under standard Chapa webhooks
//     (one URL per merchant), register api/payment-webhook there
//     instead — it handles BOTH payment types. This file's
//     dashboard-webhook path is a fallback in case you register
//     this URL specifically.
//
//  On success this only ever moves escrow status from 'pending'
//  to 'held'. Release to the seller is a separate admin-only step
//  (api/escrow-action.js) after physical handoff is confirmed.
//
//  Env vars needed:
//    CHAPA_SECRET_KEY, CHAPA_WEBHOOK_SECRET,
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ══════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { applyEscrow, applyPayment } from "./_chapa-apply.js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  api: { bodyParser: false }, // need raw bytes for HMAC on POST
};

// ── GET callback rate limiter (same policy as payment-webhook.js) ──
const GET_RATE_LIMIT_WINDOW_MS = 60_000;
const GET_RATE_LIMIT_MAX       = 5;
const getCallCounts = new Map();

function isGetRateLimited(tx_ref) {
  const now = Date.now();
  const entry = getCallCounts.get(tx_ref);
  if (!entry || now - entry.windowStart > GET_RATE_LIMIT_WINDOW_MS) {
    getCallCounts.set(tx_ref, { count: 1, windowStart: now });
    return false;
  }
  if (entry.count >= GET_RATE_LIMIT_MAX) return true;
  entry.count++;
  return false;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") return res.status(405).end();

  let tx_ref;

  if (req.method === "POST") {
    // ── Signed webhook ──
    const rawBody = await readRawBody(req);

    const expectedSig = crypto
      .createHmac("sha256", process.env.CHAPA_WEBHOOK_SECRET)
      .update(rawBody)
      .digest("hex");

    const receivedSig = req.headers["x-chapa-signature"];
    const sigsMatch =
      receivedSig &&
      receivedSig.length === expectedSig.length &&
      crypto.timingSafeEqual(
        Buffer.from(receivedSig, "hex"),
        Buffer.from(expectedSig, "hex")
      );

    if (!sigsMatch) {
      console.warn("escrow-webhook: signature mismatch — ignoring.");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(rawBody);
    tx_ref = event.tx_ref;
  } else {
    // ── Unsigned GET callback_url hit from escrow-init.js ──
    // Chapa uses "trx_ref" (not "tx_ref") here.
    tx_ref = req.query?.trx_ref || req.query?.tx_ref;
    if (tx_ref && isGetRateLimited(tx_ref)) {
      return res.status(429).json({ error: "Too many requests for this tx_ref" });
    }
  }

  if (!tx_ref) return res.status(400).json({ error: "Missing tx_ref" });

  try {
    // Try escrow first (this file's primary purpose)
    const escrowResult = await applyEscrow(supabaseAdmin, tx_ref);
    if (escrowResult.handled) {
      if (escrowResult.error) {
        console.error("escrow-webhook:", escrowResult.error, tx_ref);
        return res.status(escrowResult.status || 500).json({ error: escrowResult.error });
      }
      return res.status(200).json({ ok: escrowResult.ok, ...escrowResult });
    }

    // Fallback: try featured-listing payment — covers the case where
    // this URL happens to be the registered dashboard webhook and a
    // bb_* payment event lands here.
    const payResult = await applyPayment(supabaseAdmin, tx_ref);
    if (payResult.handled) {
      if (payResult.error) {
        console.error("escrow-webhook (payment path):", payResult.error, tx_ref);
        return res.status(payResult.status || 500).json({ error: payResult.error });
      }
      return res.status(200).json({ ok: payResult.ok, ...payResult });
    }

    console.warn("escrow-webhook: unrecognised tx_ref prefix:", tx_ref);
    return res.status(200).json({ ok: true, skipped: true });

  } catch (error) {
    console.error("escrow-webhook error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
