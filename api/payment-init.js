// ══════════════════════════════════════════════════════
//  api/payment-init.js  —  Vercel Serverless Function
//  Starts a Chapa checkout session. Chapa itself routes the
//  payer to whichever method they pick on its hosted page:
//  Telebirr, CBE Birr/HelloCash, the 18 partner banks, or
//  international Visa/Mastercard/Amex/PayPal — so this one
//  endpoint covers all of those, instead of building a
//  separate integration per bank.
//
//  HOW TO DEPLOY (same project as api/chat.js):
//  1. Vercel dashboard → Settings → Environment Variables
//     Add: CHAPA_SECRET_KEY   = your live/test secret key
//     Add: CHAPA_WEBHOOK_SECRET = the webhook secret shown in
//          Chapa Dashboard → Settings → Webhooks
//     Add: ALLOWED_ORIGIN     = https://www.bridge-broker.com
//     Add: SUPABASE_URL       = https://xrmbzycasbzdaolvtuop.supabase.co
//     Add: SUPABASE_SERVICE_ROLE_KEY = your Supabase service role key
//          (Settings → API in Supabase — NOT the publishable key,
//          this one must stay server-side only)
//  2. Deploy
//
//  Sign up for a Chapa merchant account: https://dashboard.chapa.co
// ══════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Pricing — keep in sync with what's shown in seller-dashboard.html
const PRICING = {
  featured_1week:  { amount: 200,  weeks: 1, label: "Featured Listing — 1 week"  },
  featured_4weeks: { amount: 700,  weeks: 4, label: "Featured Listing — 4 weeks" },
  verified_badge:  { amount: 0,    weeks: 0, label: "Verified Seller Badge"      }, // free, kept for clarity — verification itself is admin-reviewed, not paid
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const { listingId, plan, email, firstName, lastName, phone, returnUrl, accessToken } =
      req.body ?? {};

    if (!listingId || !plan || !email || !accessToken)
      return res.status(400).json({ error: "listingId, plan, email and accessToken are required" });

    const pricing = PRICING[plan];
    if (!pricing || pricing.amount <= 0)
      return res.status(400).json({ error: "Invalid plan" });

    // ── Verify the caller is actually logged in and owns this listing ──
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(accessToken);
    if (userErr || !userData?.user)
      return res.status(401).json({ error: "Not authenticated" });

    const { data: listing, error: listingErr } = await supabaseAdmin
      .from("listings")
      .select("id, seller_id")
      .eq("id", listingId)
      .single();

    if (listingErr || !listing)
      return res.status(404).json({ error: "Listing not found" });

    if (listing.seller_id !== userData.user.id)
      return res.status(403).json({ error: "You don't own this listing" });

    // ── Create a pending payment record we can reconcile later ──
    const tx_ref = `bb_${listingId}_${Date.now()}`;

    const { error: payErr } = await supabaseAdmin.from("payments").insert([{
      tx_ref,
      listing_id: listingId,
      user_id: userData.user.id,
      plan,
      amount: pricing.amount,
      currency: "ETB",
      status: "pending",
    }]);
    if (payErr) throw payErr;

    // ── Ask Chapa to start the checkout session ──
    const chapaRes = await fetch("https://api.chapa.co/v1/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: String(pricing.amount),
        currency: "ETB",
        email,
        first_name: firstName || "Bridge",
        last_name: lastName || "Broker",
        phone_number: phone || undefined,
        tx_ref,
        callback_url: `${process.env.SITE_URL || ""}/api/payment-webhook`,
        return_url: returnUrl || `${process.env.SITE_URL || ""}/seller-dashboard.html?payment=processing`,
        customization: {
          title: "Bridge Broker",
          description: pricing.label,
        },
      }),
    });

    const chapaData = await chapaRes.json();

    if (!chapaRes.ok || chapaData.status !== "success") {
      console.error("Chapa init error:", JSON.stringify(chapaData));
      await supabaseAdmin.from("payments").update({ status: "failed" }).eq("tx_ref", tx_ref);
      return res.status(502).json({ error: chapaData.message || "Could not start payment" });
    }

    // checkout_url is Chapa's hosted page — it shows Telebirr, CBE Birr,
    // bank list, and card options to the payer; we never see card numbers.
    return res.status(200).json({ checkout_url: chapaData.data.checkout_url, tx_ref });
  } catch (error) {
    console.error("payment-init error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
