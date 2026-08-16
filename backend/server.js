'use strict';

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve the frontend from the parent directory
app.use(express.static(path.join(__dirname, '..')));

// ── POST /api/assistant ───────────────────────────────────────────────────────
app.post('/api/assistant', async (req, res) => {
  const {
    userQuestion,
    walletLoaded   = false,
    walletAddress  = '',
    riskScore      = null,
    flaggedReasons = []
  } = req.body;

  if (!userQuestion || typeof userQuestion !== 'string') {
    return res.status(400).json({ error: 'userQuestion is required' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'API key not configured' });
  }

  // Build system prompt based on context
  const systemPrompt = walletLoaded
    ? `You are the FlowTrace Assistant, embedded in a wallet-risk investigation tool for law enforcement investigators. Your name is strictly "FlowTrace Assistant". NEVER call yourself "CryptoTrace". Answer ONLY using the wallet data provided below. Keep responses to 2-4 sentences, plain English, no jargon unless you define it. Only describe features that actually exist in this demo: a risk score (0-100), 2-3 flagged reasons per wallet, and a transaction flow graph showing connected wallets. Do not claim the tool has features it doesn't have, such as live blockchain scanning, a database of known bad actors, or full transaction history beyond what's shown in the demo. If asked about a capability that doesn't exist, say it's part of the planned roadmap, not a current feature.

Current wallet: ${walletAddress}
Risk score: ${riskScore}/100
Flagged reasons: ${flaggedReasons.join(', ')}`
    : `You are the FlowTrace Assistant, embedded in a wallet-risk investigation tool for law enforcement investigators. Your name is strictly "FlowTrace Assistant". NEVER call yourself "CryptoTrace". No wallet is currently loaded. Answer general questions about how the tool works, what risk scoring means, or how to get started. Keep responses to 2-4 sentences, plain English. Only describe features that actually exist in this demo: a risk score (0-100), 2-3 flagged reasons per wallet, and a transaction flow graph showing connected wallets. Do not claim the tool has features it doesn't have, such as live blockchain scanning, a database of known bad actors, or full transaction history beyond what's shown in the demo. If asked about a capability that doesn't exist, say it's part of the planned roadmap, not a current feature.`;

  const requestBody = {
    model: 'anthropic/claude-sonnet-4-5',
    max_tokens: 300,
    messages: [
      { role: 'system',  content: systemPrompt },
      { role: 'user',    content: userQuestion }
    ]
  };

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer':  req.headers.origin || `http://localhost:${PORT}`,
        'X-Title':       'FlowTrace'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[OpenRouter] error:', response.status, errText);
      return res.status(502).json({ error: 'Upstream API error' });
    }

    const data = await response.json();
    // OpenRouter returns OpenAI-compatible shape: choices[0].message.content
    const reply = data?.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      console.error('[OpenRouter] unexpected response shape:', JSON.stringify(data));
      return res.status(502).json({ error: 'Empty reply from model' });
    }

    return res.json({ reply });

  } catch (err) {
    console.error('[/api/assistant] fetch error:', err.message);
    return res.status(502).json({ error: 'Network error reaching upstream API' });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`FlowTrace backend running at http://localhost:${PORT}`);
  console.log(`API key configured: ${process.env.OPENROUTER_API_KEY ? 'YES' : 'NO — add your key to backend/.env'}`);
});
