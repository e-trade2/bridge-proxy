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
//     Add: SITE_URL              = https://www.bridge-broker.com
//          (used as the base for Chapa callback_url and return_url)
//  2. Deploy
//
//  Sign up for a Chapa merchant account: https://dashboard.chapa.co
// ══════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "null"; // fails closed — set ALLOWED_ORIGIN in Vercel to your real domain (e.g. https://www.bridge-broker.com)

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Pricing — loaded from Supabase admin_settings at request time so the
// admin can change prices from admin.html without touching code.
// Falls back to hardcoded defaults if the DB rows don't exist yet.
const PRICING_DEFAULTS = {
  featured_1week:  { amount: 200, weeks: 1, label: "Featured Listing — 1 week"  },
  featured_4weeks: { amount: 700, weeks: 4, label: "Featured Listing — 4 weeks" },
  verified_badge:  { amount: 0,   weeks: 0, label: "Verified Seller Badge"      },
};

async function getPricing(supabaseAdmin) {
  const pricing = JSON.parse(JSON.stringify(PRICING_DEFAULTS)); // deep copy
  try {
    const { data } = await supabaseAdmin
      .from("admin_settings")
      .select("key, value")
      .in("key", ["bb_price_featured_1week", "bb_price_featured_4weeks"]);
    (data || []).forEach(row => {
      if (row.key === "bb_price_featured_1week"  && row.value) pricing.featured_1week.amount  = Number(row.value);
      if (row.key === "bb_price_featured_4weeks" && row.value) pricing.featured_4weeks.amount = Number(row.value);
    });
  } catch (e) {
    console.warn("payment-init: could not load pricing from DB, using defaults:", e.message);
  }
  return pricing;
}

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

    const pricing = (await getPricing(supabaseAdmin))[plan];
    if (!pricing)
      return res.status(400).json({ error: "Invalid plan" });

    // verified_badge is free and admin-reviewed — it never goes through
    // a payment checkout, so this endpoint has nothing to do for it.
    if (pricing.amount <= 0)
      return res.status(400).json({ error: "The verified_badge plan has no payment — badge requests are handled by the admin directly." });

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

    // ── Normalize phone for Chapa, if we have one ──
    // user.phone (Supabase Auth) is usually empty here since this app
    // only does email/password signup — phone auth needs a paid Supabase
    // plan (see README). When it IS present, Chapa's API wants LOCAL
    // 10-digit format — 09xxxxxxxx or 07xxxxxxxx — not +251xxxxxxxxx or
    // any other raw format auth.users.phone might happen to hold.
    // (Confirmed against Chapa's own docs/example payload at
    // developer.chapa.co/integrations/accept-payments, which uses
    // "phone_number": "0912345678".)
    const toChapaPhone = (raw) => {
      if (!raw) return undefined;
      let d = String(raw).replace(/[\s\-().]/g, '');
      if (d.startsWith('+251')) d = d.slice(4);
      else if (d.startsWith('251')) d = d.slice(3);
      if (d.length === 9 && /^[79]\d{8}$/.test(d)) d = '0' + d;
      return /^0[79]\d{8}$/.test(d) ? d : undefined; // not a recognisable ET mobile number — omit rather than send something Chapa will choke on
    };
    const chapaPhoneNumber = toChapaPhone(phone);

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
        phone_number: chapaPhoneNumber,
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
