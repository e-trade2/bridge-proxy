// ══════════════════════════════════════════════════════
//  api/escrow-init.js  —  Vercel Serverless Function
//  Admin-only. Creates an OPTIONAL escrow payment link for a
//  specific listing when a buyer wants protection instead of
//  the default in-person cash/transfer handoff.
//
//  The buyer does NOT need an account — the admin collects their
//  name/phone/email and sends them the resulting checkout_url
//  directly (phone call, Telegram, SMS).
//
//  Env vars needed (same Vercel project as payment-init.js):
//    CHAPA_SECRET_KEY, CHAPA_WEBHOOK_SECRET, ALLOWED_ORIGIN,
//    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SITE_URL
// ══════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

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
    const {
      listingId, amount, buyerName, buyerPhone, buyerEmail, accessToken,
    } = req.body ?? {};

    if (!listingId || !amount || !buyerName || !buyerPhone || !accessToken)
      return res.status(400).json({
        error: "listingId, amount, buyerName, buyerPhone and accessToken are required",
      });

    if (typeof amount !== "number" || amount <= 0)
      return res.status(400).json({ error: "amount must be a positive number" });

    // Validate buyerEmail format when provided — Chapa rejects malformed addresses.
    if (buyerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail))
      return res.status(400).json({ error: "buyerEmail is not a valid email address" });

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

    // ── Make sure the listing exists and is approved ──
    const { data: listing, error: listingErr } = await supabaseAdmin
      .from("listings")
      .select("id, seller_id, status, brand, model, commission_percent")
      .eq("id", listingId)
      .single();

    if (listingErr || !listing)
      return res.status(404).json({ error: "Listing not found" });

    if (listing.status !== "approved")
      return res.status(400).json({ error: "Escrow can only be created for approved listings" });

    // Fail early here rather than at release time — every approved
    // listing should already have a commission rate set (it's
    // required in the approval modal), but this guards against older
    // rows approved before that field existed.
    if (listing.commission_percent == null)
      return res.status(400).json({
        error: "This listing has no commission rate on record. Re-approve it to set one before creating an escrow link.",
      });

    // Normalize Ethiopian phone to +251XXXXXXXXX for Chapa compatibility
    const normalizePhone = (raw) => {
      if (!raw) return raw;
      let d = String(raw).replace(/[\s\-().]/g, '');
      if (d.startsWith('+251')) d = d.slice(1);
      if (d.startsWith('0')) d = '251' + d.slice(1);
      // Ethiopian mobile prefixes: 09xx and 07xx both valid.
      return /^251[79]\d{8}$/.test(d) ? '+' + d : raw;
    };
    const normalizedBuyerPhone = normalizePhone(buyerPhone);

    // ── Create the pending escrow row ──
    const tx_ref = `bbescrow_${listingId}_${Date.now()}`;

    const { error: insertErr } = await supabaseAdmin.from("escrow_transactions").insert([{
      tx_ref,
      listing_id: listingId,
      seller_id: listing.seller_id,
      created_by: userData.user.id,
      buyer_name: buyerName,
      buyer_phone: normalizedBuyerPhone,
      buyer_email: buyerEmail || null,
      amount,
      currency: "ETB",
      status: "pending",
    }]);
    if (insertErr) throw insertErr;

    // ── Ask Chapa to start the checkout session ──
    const chapaRes = await fetch("https://api.chapa.co/v1/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: String(amount),
        currency: "ETB",
        email: buyerEmail || "buyer@bridge-broker.com",
        first_name: buyerName.split(" ")[0] || "Buyer",
        last_name: buyerName.split(" ").slice(1).join(" ") || "BridgeBroker",
        phone_number: normalizedBuyerPhone,
        tx_ref,
        callback_url: `${process.env.SITE_URL || ""}/api/escrow-webhook`,
        return_url: `${process.env.SITE_URL || ""}/listings.html?escrow=processing`,
        customization: {
          title: "Bridge Broker Escrow",
          description: `Escrow hold for ${listing.brand} ${listing.model}`,
        },
      }),
    });

    const chapaData = await chapaRes.json();

    if (!chapaRes.ok || chapaData.status !== "success") {
      console.error("Chapa escrow init error:", JSON.stringify(chapaData));
      await supabaseAdmin.from("escrow_transactions").update({ status: "cancelled" }).eq("tx_ref", tx_ref);
      return res.status(502).json({ error: chapaData.message || "Could not start escrow payment" });
    }

    return res.status(200).json({ checkout_url: chapaData.data.checkout_url, tx_ref });
  } catch (error) {
    console.error("escrow-init error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
