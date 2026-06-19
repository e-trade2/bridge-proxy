// ══════════════════════════════════════════════════════
//  api/chat.js  —  Vercel Serverless Proxy
//  Keeps your Gemini API key secret on the server
//
//  HOW TO DEPLOY:
//  1. In Vercel dashboard → Settings → Environment Variables
//     Add: GEMINI_API_KEY = AQ.Ab8RN6...[your key]
//  2. Deploy project
// ══════════════════════════════════════════════════════

export default async function handler(req, res) {
  // Allow requests from your Bridge Broker local domain
  res.setHeader('Access-Control-Allow-Origin', '*'); 
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
    // Convert generic messages ({role, content}) to Gemini's format
    const geminiContents = messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }]
    }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: geminiContents,
          // FIXED: Must be snake_case for the REST endpoint to read your prompt
          system_instruction: { parts: [{ text: system || '' }] },
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

    // Return in the exact shape your delala-ai.js frontend expects
    return res.status(200).json({
      content: [{ text: aiText }]
    });

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
