// ══════════════════════════════════════════════════════
//  api/debug-env.js  —  TEMPORARY debug endpoint
//  Confirms whether env vars are reaching this function,
//  WITHOUT ever printing their actual values.
//  DELETE THIS FILE once the problem is found — never leave
//  a debug endpoint like this in a real deployment long-term.
// ══════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const check = (name) => {
    const val = process.env[name];
    return {
      exists: val !== undefined,
      length: val ? val.length : 0,
      // show only first 4 and last 4 characters, never the middle —
      // enough to confirm it's the right key without leaking it
      preview: val && val.length > 10
        ? `${val.slice(0, 4)}...${val.slice(-4)}`
        : (val ? "(too short to preview safely)" : null),
    };
  };

  return res.status(200).json({
    SUPABASE_URL: check("SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: check("SUPABASE_SERVICE_ROLE_KEY"),
    GEMINI_API_KEY: check("GEMINI_API_KEY"),
    ALLOWED_ORIGIN: check("ALLOWED_ORIGIN"),
    CRON_SECRET: check("CRON_SECRET"),
  });
}
