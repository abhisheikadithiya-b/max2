// api/chat.js (Vercel Serverless Function)
export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { contents, model, systemInstruction } = req.body;
  const apiKey = process.env.GEMINI_API_KEY; // Read from Vercel Environment Variables

  if (!apiKey) {
    return res.status(500).json({ 
      error: 'Gemini API Key is not configured on the Vercel server. Please configure GEMINI_API_KEY in Vercel settings.' 
    });
  }

  // Use the requested model or default to gemini-3.1-flash-lite
  const selectedModel = model || 'gemini-3.1-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ contents, systemInstruction })
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    console.error('[Vercel Serverless Function Error]:', error);
    return res.status(500).json({ error: error.message });
  }
}
