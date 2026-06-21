// ══════════════════════════════════════════════════════
//  api/delete-listing-photos.js  —  Vercel Serverless Function
//  Admin-only. Deletes a listing's photos from the
//  'listing-photos' storage bucket to free up space, without
//  touching the listing's database row — so sale history,
//  commission records, and stats are preserved permanently.
//
//  Intended use: after a listing is marked 'sold' (see
//  admin.html → All Listings → Mark as Sold), the admin can
//  clear its photos once they're no longer needed publicly.
//  Only allowed for listings already in 'sold' or 'rejected'
//  status — refuses to touch photos for anything still
//  pending/approved, since those still need their images live.
//
//  Env vars needed: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ══════════════════════════════════════════════════════

import { createClient } from "@supabase/supabase-js";

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const BUCKET = "listing-photos";

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
    const { listingId, accessToken } = req.body ?? {};

    if (!listingId || !accessToken)
      return res.status(400).json({ error: "listingId and accessToken are required" });

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

    // ── Load the listing ──
    const { data: listing, error: listingErr } = await supabaseAdmin
      .from("listings")
      .select("id, status, photos")
      .eq("id", listingId)
      .single();

    if (listingErr || !listing)
      return res.status(404).json({ error: "Listing not found" });

    // Only allow this for listings that are done being shown publicly —
    // never delete photos for something still pending or approved/live.
    if (!["sold", "rejected"].includes(listing.status))
      return res.status(400).json({
        error: `Can only delete photos for sold or rejected listings (this one is '${listing.status}').`,
      });

    if (!listing.photos?.length)
      return res.status(200).json({ ok: true, deleted: 0, message: "No photos to delete." });

    // listings.photos stores full public URLs, e.g.
    // https://xxx.supabase.co/storage/v1/object/public/listing-photos/<filename>
    // — extract just the filename (the part after the bucket name) for
    // the storage API, which wants object paths, not full URLs.
    const fileNames = listing.photos
      .map((url) => {
        try {
          const u = new URL(url);
          const marker = `/storage/v1/object/public/${BUCKET}/`;
          const idx = u.pathname.indexOf(marker);
          if (idx === -1) return null;
          return decodeURIComponent(u.pathname.slice(idx + marker.length));
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (!fileNames.length)
      return res.status(400).json({ error: "Could not parse any photo filenames from this listing's stored URLs." });

    const { data: removed, error: removeErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .remove(fileNames);

    if (removeErr) throw removeErr;

    // Clear the photos array on the listing so the UI (and any cached
    // public URLs) stop referencing files that no longer exist.
    const { error: updErr } = await supabaseAdmin
      .from("listings")
      .update({ photos: [] })
      .eq("id", listingId);
    if (updErr) throw updErr;

    return res.status(200).json({ ok: true, deleted: removed?.length ?? fileNames.length });
  } catch (error) {
    console.error("delete-listing-photos error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
