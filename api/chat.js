// ══════════════════════════════════════════════════════
//  api/chat.js  —  Vercel Serverless Proxy  (v3 — Groq)
//  Keeps your Groq API key secret on the server
//
//  HOW TO DEPLOY:
//  1. Vercel dashboard → Settings → Environment Variables
//     Add: GROQ_API_KEY = your key  (get one free at console.groq.com)
//     Add: ALLOWED_ORIGIN = https://www.bridge-broker.com
//  2. Deploy project
// ══════════════════════════════════════════════════════

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

export default async function handler(req, res) {
  // ── CORS ────────────────────────────────────────────
  // In production: set ALLOWED_ORIGIN env var to your real domain,
  // e.g. https://www.bridge-broker.com  — never leave it as * in prod.
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  // ── Input validation ────────────────────────────────
  const { system, messages } = req.body ?? {};

  if (!messages || !Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: "messages array required" });

  // Guard: reject suspiciously large payloads (basic abuse prevention)
  if (messages.length > 40)
    return res.status(400).json({ error: "Conversation too long" });

  try {
    // Convert generic {role, content} → OpenAI/Groq chat format
    const groqMessages = [
      ...(system ? [{ role: "system", content: String(system) }] : []),
      ...messages.map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: String(m.content ?? ""),
      })),
    ];

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: groqMessages,
          temperature: 0.7,
          max_tokens: 400,
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Groq API error:", JSON.stringify(data));
      return res
        .status(response.status)
        .json({ error: data.error?.message || "AI service unavailable" });
    }

    const aiText =
      data.choices?.[0]?.message?.content ||
      "Sorry, I couldn't respond right now.";

    // Return in the shape delala-ai.js expects
    return res.status(200).json({ content: [{ text: aiText }] });
  } catch (error) {
    console.error("Proxy error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
