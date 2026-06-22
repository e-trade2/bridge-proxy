// ══════════════════════════════════════════════════════
//  api/banks.js  —  Vercel Serverless Function
//  Proxies Chapa's GET /v1/banks endpoint so the frontend
//  can populate a bank selector without exposing the secret
//  key. Results are cached in memory for 1 hour since bank
//  lists change rarely.
//
//  Env vars needed: CHAPA_SECRET_KEY, ALLOWED_ORIGIN
// ══════════════════════════════════════════════════════

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "null";

// In-memory cache — resets on cold-start (acceptable, bank
// list rarely changes and cold-starts are infrequent).
let cachedBanks = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const now = Date.now();
    if (cachedBanks && now - cacheTime < CACHE_TTL_MS) {
      return res.status(200).json({ banks: cachedBanks });
    }

    const chapaRes = await fetch("https://api.chapa.co/v1/banks", {
      headers: {
        Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
      },
    });

    const chapaData = await chapaRes.json();

    if (!chapaRes.ok || !chapaData.data) {
      console.error("Chapa banks error:", JSON.stringify(chapaData));
      return res.status(502).json({ error: "Could not fetch bank list" });
    }

    // Chapa returns an array of { id, swift, name, acct_length, country_id }
    // We expose only what the UI needs: id (used as bank_code) and name.
    const banks = chapaData.data.map((b) => ({
      id: b.id,
      name: b.name,
    }));

    cachedBanks = banks;
    cacheTime = now;

    return res.status(200).json({ banks });
  } catch (error) {
    console.error("banks.js error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
