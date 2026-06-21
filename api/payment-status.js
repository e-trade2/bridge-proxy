// ══════════════════════════════════════════════════════
//  api/payment-status.js  —  Vercel Serverless Function
//  Lets the frontend poll "did my payment go through yet?"
//  after Chapa redirects the user back to the site — the
//  webhook (api/payment-webhook.js) usually lands within a
//  few seconds, but the redirect can arrive first.
//
//  Auth required: the caller must supply their Supabase
//  access token and must own the payment being queried.
//  This prevents one user from polling another user's
//  payment details by guessing a tx_ref.
// ══════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const { tx_ref } = req.query;
  if (!tx_ref) return res.status(400).json({ error: "tx_ref required" });

  // ── Verify the caller is authenticated ──
  // Access token is passed as a Bearer header: Authorization: Bearer <token>
  const authHeader = req.headers.authorization || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken)
    return res.status(401).json({ error: "Authorization header required" });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(accessToken);
  if (userErr || !userData?.user)
    return res.status(401).json({ error: "Not authenticated" });

  // ── Look up the payment and verify ownership ──
  const { data, error } = await supabaseAdmin
    .from("payments")
    .select("status, plan, amount, currency, method, completed_at, user_id")
    .eq("tx_ref", tx_ref)
    .single();

  if (error || !data) return res.status(404).json({ error: "Not found" });

  // Only the seller who created the payment (or an admin) may query it.
  const isOwner = data.user_id === userData.user.id;
  if (!isOwner) {
    // Check if admin
    const { data: adminRow } = await supabaseAdmin
      .from("admins")
      .select("user_id")
      .eq("user_id", userData.user.id)
      .single();
    if (!adminRow)
      return res.status(403).json({ error: "Forbidden" });
  }

  // Return the status fields only — never expose user_id to the client
  const { user_id: _omit, ...safeData } = data;
  return res.status(200).json(safeData);
}
