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

// ── In-memory cache for Alchemy wallet responses (TTL: 60 s) ─────────────────
const walletCache = new Map(); // address → { data, expiresAt }

// ── GET /api/wallet/:address ──────────────────────────────────────────────────
app.get('/api/wallet/:address', async (req, res) => {
  const { address } = req.params;

  // Validate Ethereum address: 0x + 40 hex chars
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({
      error: 'Invalid Ethereum address — must be 0x followed by exactly 40 hexadecimal characters.'
    });
  }

  const alchemyKey = process.env.ALCHEMY_API_KEY;
  if (!alchemyKey) {
    return res.status(503).json({ error: 'ALCHEMY_API_KEY not configured on server.' });
  }

  // Serve from cache if still fresh
  const cached = walletCache.get(address);
  if (cached && Date.now() < cached.expiresAt) {
    return res.json({ ...cached.data, _cached: true });
  }

  const alchemyUrl = `https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`;

  // Helper — POST a single JSON-RPC call to Alchemy
  async function alchemyRpc(body) {
    const r = await fetch(alchemyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Alchemy HTTP ${r.status}: ${text}`);
    }
    const json = await r.json();
    if (json.error) {
      throw new Error(`Alchemy RPC error ${json.error.code}: ${json.error.message}`);
    }
    return json.result;
  }

  try {
    // Fire all three requests in parallel
    const [outResult, inResult, balanceHex] = await Promise.all([
      // Outgoing transfers (fromAddress)
      alchemyRpc({
        jsonrpc: '2.0', id: 1,
        method: 'alchemy_getAssetTransfers',
        params: [{
          fromBlock: '0x0',
          fromAddress: address,
          category: ['external', 'erc20'],
          withMetadata: true,
          excludeZeroValue: true,
          maxCount: '0x64',
          order: 'desc'
        }]
      }),
      // Incoming transfers (toAddress)
      alchemyRpc({
        jsonrpc: '2.0', id: 2,
        method: 'alchemy_getAssetTransfers',
        params: [{
          fromBlock: '0x0',
          toAddress: address,
          category: ['external', 'erc20'],
          withMetadata: true,
          excludeZeroValue: true,
          maxCount: '0x64',
          order: 'desc'
        }]
      }),
      // ETH balance
      alchemyRpc({
        jsonrpc: '2.0', id: 3,
        method: 'eth_getBalance',
        params: [address, 'latest']
      })
    ]);

    // Convert Wei hex to ETH (BigInt to handle very large numbers)
    const balanceWei = BigInt(balanceHex);
    const balanceEth = Number(balanceWei) / 1e18;

    // Merge transfers, dedupe by hash+asset, normalise shape
    const seen = new Set();
    const transfers = [];

    for (const tx of [...(outResult.transfers || []), ...(inResult.transfers || [])]) {
      const key = `${tx.hash}-${tx.asset || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      transfers.push({
        hash:      tx.hash,
        from:      tx.from,
        to:        tx.to,
        value:     tx.value,          // numeric, already in token units
        asset:     tx.asset || 'ETH', // token symbol
        category:  tx.category,       // 'external' | 'erc20'
        timestamp: tx.metadata?.blockTimestamp || null
      });
    }

    // Sort newest first (ISO timestamps sort lexicographically)
    transfers.sort((a, b) => {
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return b.timestamp.localeCompare(a.timestamp);
    });

    const payload = {
      address,
      balanceEth,
      totalTransfers: transfers.length,
      transfers
    };

    // Store in cache for 60 seconds
    walletCache.set(address, { data: payload, expiresAt: Date.now() + 60_000 });

    return res.json(payload);

  } catch (err) {
    console.error('[/api/wallet] Alchemy error:', err.message);
    return res.status(502).json({ error: `Alchemy request failed: ${err.message}` });
  }
});

// ── In-memory cache for Scoring responses (TTL: 60 s) ───────────────────────
const scoringCache = new Map(); // address → { data, expiresAt }
const { scoreWallet } = require('./riskScoring');

// ── GET /api/wallet/:address/score ────────────────────────────────────────────
app.get('/api/wallet/:address/score', async (req, res) => {
  const { address } = req.params;

  // Serve from cache if still fresh
  const cached = scoringCache.get(address);
  if (cached && Date.now() < cached.expiresAt) {
    return res.json({ ...cached.data, _cached: true });
  }

  try {
    // Call our own raw wallet endpoint to get the data (re-uses its own cache)
    const rawRes = await fetch(`http://localhost:${PORT}/api/wallet/${encodeURIComponent(address)}`);
    const rawData = await rawRes.json();

    if (!rawRes.ok) {
      return res.status(rawRes.status).json(rawData);
    }

    // Pass the raw Alchemy data through our scoring module
    const scoring = scoreWallet(rawData);
    const payload = { ...rawData, scoring };

    // Store in cache for 60 seconds
    scoringCache.set(address, { data: payload, expiresAt: Date.now() + 60_000 });

    return res.json(payload);
  } catch (err) {
    console.error('[/api/wallet/score] Error:', err.message);
    return res.status(502).json({ error: `Scoring failed: ${err.message}`, scoringError: true });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`FlowTrace backend running at http://localhost:${PORT}`);
  console.log(`OpenRouter API key: ${process.env.OPENROUTER_API_KEY ? 'YES' : 'NO — add to backend/.env'}`);
  console.log(`Alchemy API key:    ${process.env.ALCHEMY_API_KEY    ? 'YES' : 'NO — add to backend/.env'}`);
});
