// ══════════════════════════════════════════════════════
//  api/chat.js  —  Vercel Serverless Proxy
//  Keeps your Claude API key secret on the server
//
//  HOW TO DEPLOY (5 minutes):
//  1. Create a free account at vercel.com
//  2. Install Vercel CLI:  npm install -g vercel
//  3. Create a new folder called "bridge-broker-proxy"
//  4. Put this file inside it at: api/chat.js
//  5. Also create package.json (see bottom of this file)
//  6. Run: vercel deploy
//  7. In Vercel dashboard → Settings → Environment Variables
//     Add: ANTHROPIC_API_KEY = sk-ant-...your key...
//  8. Copy your deployment URL and paste it into
//     delala-ai.js as the PROXY_URL value
// ══════════════════════════════════════════════════════

export default async function handler(req, res) {
  // Allow requests from your Bridge Broker domain
  res.setHeader('Access-Control-Allow-Origin', '*'); // Change to your domain in production
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { system, messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    // Convert Claude-style messages ({role, content}) to Gemini's format
    const geminiContents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: geminiContents,
          systemInstruction: { parts: [{ text: system || '' }] },
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 400
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini API error:', JSON.stringify(data));
      return res.status(response.status).json({ error: data.error?.message || 'AI service unavailable' });
    }

    const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't respond right now.";

    // Return in the same shape delala-ai.js already expects: data.content[0].text
    return res.status(200).json({
      content: [{ text: aiText }]
    });

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ── package.json for the proxy folder ────────────────
// Create a file called package.json with this content:
//
// {
//   "name": "bridge-broker-proxy",
//   "version": "1.0.0",
//   "private": true
// }
