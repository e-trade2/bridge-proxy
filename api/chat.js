export default async function handler(req, res) {
  // Setup standard CORS headers so your local frontend (port 5500) can connect
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { system, messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // Convert incoming messages array to Google's standard multi-turn format
  const geminiMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // FIXED: system_instruction is positioned as a top-level property
          system_instruction: { parts: [{ text: system || '' }] },
          contents: geminiMessages,
          generationConfig: { 
            maxOutputTokens: 400, 
            temperature: 0.7 
          }
        })
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error('Gemini API error payload:', err);
      return res.status(502).json({ error: 'AI service unavailable' });
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't respond right now.";

    // Return structure matching Claude framework layout so delala-ai.js maps correctly
    return res.status(200).json({
      content: [{ type: 'text', text }]
    });

  } catch (error) {
    console.error('Proxy routing error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
