// ══════════════════════════════════════════════════════
//  api/payment-webhook.js  —  Vercel Serverless Function
//
//  Handles Chapa payment notifications via TWO mechanisms:
//
//  1. callback_url (set per-transaction in payment-init.js)
//     Chapa sends a GET here with ?trx_ref=...&status=...
//     No signature — treated as an untrusted nudge only.
//
//  2. Dashboard webhook (configured ONCE in Chapa Dashboard →
//     Profile → Webhooks — NOT set in code) — signed POST with
//     x-chapa-signature header. This is the reliable path.
//
//  ┌─ SINGLE WEBHOOK URL SETUP (IMPORTANT) ────────────────┐
//  │ Chapa only supports ONE webhook URL per merchant       │
//  │ account. Register THIS file's URL in the dashboard:   │
//  │   https://<your-deployment>/api/payment-webhook       │
//  │                                                        │
//  │ This endpoint handles BOTH payment types:             │
//  │  • bb_*      → featured-listing payments              │
//  │  • bbescrow_ → escrow payments (dispatched internally)│
//  │                                                        │
//  │ You do NOT also need to register api/escrow-webhook.  │
//  │ That file remains as a standalone route only for      │
//  │ direct GET callback_url hits from escrow-init.js.     │
//  └────────────────────────────────────────────────────────┘
//
//  Env vars needed:
//    CHAPA_SECRET_KEY, CHAPA_WEBHOOK_SECRET,
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ══════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { applyPayment, applyEscrow } from "./_chapa-apply.js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  api: { bodyParser: false }, // need raw bytes for HMAC on POST
};

// ── GET callback rate limiter ──────────────────────────────────────
// The unsigned GET path is an untrusted nudge from Chapa's redirect.
// Without rate limiting, anyone who spots a tx_ref in a return URL
// can spam this endpoint, wasting Chapa API quota and server load.
// We keep a simple in-process Map (resets on cold start, good enough
// for a low-traffic deployment — use Redis/KV for high-traffic).
//
// Policy: max 5 GET requests per tx_ref per 60 seconds.
const GET_RATE_LIMIT_WINDOW_MS = 60_000;
const GET_RATE_LIMIT_MAX       = 5;
const getCallCounts = new Map(); // tx_ref → { count, windowStart }

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
    // ── Signed webhook from the Chapa Dashboard ──
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
      console.warn("payment-webhook: signature mismatch — ignoring.");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const event = JSON.parse(rawBody);
    tx_ref = event.tx_ref;
  } else {
    // ── Unsigned GET callback_url hit ──
    // Chapa uses "trx_ref" (not "tx_ref") in this payload.
    // We treat it as an untrusted trigger — the apply* helpers
    // re-verify independently with Chapa's API before doing anything.
    tx_ref = req.query?.trx_ref || req.query?.tx_ref;
    if (tx_ref && isGetRateLimited(tx_ref)) {
      return res.status(429).json({ error: "Too many requests for this tx_ref" });
    }
  }

  if (!tx_ref) return res.status(400).json({ error: "Missing tx_ref" });

  try {
    // Try featured-listing payment first (bb_* prefix)
    const payResult = await applyPayment(supabaseAdmin, tx_ref);
    if (payResult.handled) {
      if (payResult.error) {
        console.error("payment-webhook:", payResult.error, tx_ref);
        return res.status(payResult.status || 500).json({ error: payResult.error });
      }
      return res.status(200).json({ ok: payResult.ok, ...payResult });
    }

    // Fallback: try escrow (bbescrow_* prefix) — covers the case where
    // this URL is the single registered dashboard webhook and an escrow
    // payment event arrives here instead of at api/escrow-webhook.
    const escrowResult = await applyEscrow(supabaseAdmin, tx_ref);
    if (escrowResult.handled) {
      if (escrowResult.error) {
        console.error("payment-webhook (escrow path):", escrowResult.error, tx_ref);
        return res.status(escrowResult.status || 500).json({ error: escrowResult.error });
      }
      return res.status(200).json({ ok: escrowResult.ok, ...escrowResult });
    }

    // tx_ref doesn't match any known prefix
    console.warn("payment-webhook: unrecognised tx_ref prefix:", tx_ref);
    return res.status(200).json({ ok: true, skipped: true });

  } catch (error) {
    console.error("payment-webhook error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
