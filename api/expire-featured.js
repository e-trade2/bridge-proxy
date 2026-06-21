// ══════════════════════════════════════════════════════
//  api/expire-featured.js  —  Vercel Cron Function
//  Flips listings.featured back to false once
//  featured_expires_at has passed. Runs on a schedule via
//  Vercel Cron (configured in vercel.json), not called by
//  the frontend.
//
//  Env vars needed: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//  and CRON_SECRET (set the same value in vercel.json's cron
//  config / Vercel's automatic cron auth header).
// ══════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // Vercel Cron sends a bearer token matching CRON_SECRET automatically
  // when configured — reject anything else so this can't be triggered
  // by a random outsider hitting the URL. If CRON_SECRET itself isn't
  // set, fail closed (401) rather than silently allowing open access.
  if (!process.env.CRON_SECRET) {
    console.error("expire-featured: CRON_SECRET is not set — refusing to run.");
    return res.status(401).json({ error: "Unauthorized" });
  }
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("listings")
      .update({ featured: false })
      .lt("featured_expires_at", new Date().toISOString())
      .eq("featured", true)
      .select("id");

    if (error) throw error;

    return res.status(200).json({ ok: true, expired: data?.length || 0 });
  } catch (error) {
    console.error("expire-featured error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
