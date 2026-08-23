'use strict';

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');
const { loadConfig } = require('./config');
const { createAuthMiddleware } = require('./auth');
const { createRateLimiters } = require('./rateLimits');
const { createCaseRouter } = require('./cases');
const { createWalletDataFetcher } = require('./walletData');
const { createSanctionsFeed } = require('./sanctionsFeed');
const { scoreWallet } = require('./riskScoring');

const config = loadConfig();
const app  = express();
const PORT = config.port;
const auth = createAuthMiddleware(config);
const rateLimiters = createRateLimiters(config);
const fetchWalletData = createWalletDataFetcher({ alchemyApiKey: process.env.ALCHEMY_API_KEY, fetchImpl: fetch });
const sanctionsFeed = createSanctionsFeed({
  feedUrl: config.sanctionsFeedUrl,
  refreshMs: config.sanctionsFeedRefreshMs,
  requestTimeoutMs: config.sanctionsFeedRequestTimeoutMs,
  fetchImpl: fetch,
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.set('trust proxy', config.trustProxy);
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.allowedOrigins.includes(origin)) return callback(null, true);
    const error = new Error('CORS origin is not allowed.');
    error.status = 403;
    return callback(error);
  },
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-FlowTrace-Organization-Id'],
  maxAge: 600,
}));
app.use(express.json({ limit: '32kb' }));
app.use('/api', auth.attachSession);
app.use('/api/wallet', rateLimiters.wallet);
app.use('/api/assistant', rateLimiters.assistant);
// Stage 3 supplies the case handlers. Guard the namespace now so it is never
// anonymously reachable in demo mode during the intervening deployment.
app.use('/api/cases', auth.requireAuthenticatedSession, auth.requireActiveMembership);

// The browser needs only the public Supabase settings to restore a session.
// The anon key is designed for client use; the service-role key is never sent.
app.get('/api/config', (_req, res) => res.json({
  mode: config.mode,
  supabaseUrl: config.supabaseUrl,
  supabaseAnonKey: config.supabaseAnonKey,
}));

// Serve the frontend from the parent directory
app.use(express.static(path.join(__dirname, '..')));

app.get('/api/auth/me', auth.requireAuthenticatedSession, auth.requireActiveMembership, (req, res) => {
  const organizationSelectionRequired = req.auth.memberships.length > 1 && !req.auth.activeOrganization;
  return res.json({
    user: { id: req.auth.user.id, email: req.auth.user.email },
    memberships: req.auth.memberships.map(({ organization_id, organization_name, role }) => ({
      organizationId: organization_id, organizationName: organization_name, role,
    })),
    activeOrganization: req.auth.activeOrganization
      ? { organizationId: req.auth.activeOrganization.organization_id, role: req.auth.activeOrganization.role }
      : null,
    organizationSelectionRequired,
  });
});

app.post('/api/auth/claim-invitations', rateLimiters.invitations, auth.requireAuthenticatedSession, auth.claimPendingInvitations);

// ── POST /api/assistant ───────────────────────────────────────────────────────
app.post('/api/assistant', auth.requireAnalysisSession, async (req, res) => {
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

  // Disclosure: wallet address, risk score, and flags are intentionally sent
  // to OpenRouter, an external third party, in this system prompt.
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

// ── GET /api/wallet/:address ──────────────────────────────────────────────────
app.get('/api/wallet/:address', auth.requireAnalysisSession, async (req, res) => {
  const { address } = req.params;

  // Validate Ethereum address: 0x + 40 hex chars
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({
      error: 'Invalid Ethereum address — must be 0x followed by exactly 40 hexadecimal characters.'
    });
  }

  try {
    return res.json(await fetchWalletData(address));
  } catch (err) {
    console.error('[/api/wallet] Alchemy error:', err.message);
    return res.status(502).json({ error: `Alchemy request failed: ${err.message}` });
  }

});

// ── In-memory cache for Scoring responses (TTL: 60 s) ───────────────────────
const scoringCache = new Map(); // address → { data, expiresAt }
const scoringInFlight = new Map(); // normalized address → Promise<payload>

async function fetchWalletScore(address) {
  const normalizedAddress = address.toLowerCase();
  const cached = scoringCache.get(normalizedAddress);
  if (cached && Date.now() < cached.expiresAt) return { ...cached.data, _cached: true };

  const pending = scoringInFlight.get(normalizedAddress);
  if (pending) return pending;

  const request = (async () => {
    const [rawData, sanctionsSnapshot] = await Promise.all([
      fetchWalletData(normalizedAddress),
      sanctionsFeed.getSnapshot(),
    ]);
    const payload = {
      ...rawData,
      scoring: scoreWallet(rawData, sanctionsSnapshot),
      sanctions: {
        source: sanctionsSnapshot.source,
        refreshedAt: sanctionsSnapshot.refreshedAt,
        stale: sanctionsSnapshot.stale,
        addressCount: sanctionsSnapshot.addresses.size,
      },
    };
    scoringCache.set(normalizedAddress, { data: payload, expiresAt: Date.now() + 60_000 });
    return payload;
  })();

  scoringInFlight.set(normalizedAddress, request);
  try {
    return await request;
  } finally {
    if (scoringInFlight.get(normalizedAddress) === request) scoringInFlight.delete(normalizedAddress);
  }
}

// ── GET /api/wallet/:address/score ────────────────────────────────────────────
app.get('/api/wallet/:address/score', auth.requireAnalysisSession, async (req, res) => {
  const { address } = req.params;

  try {
    return res.json(await fetchWalletScore(address));
  } catch (err) {
    console.error('[/api/wallet/score] Error:', err.message);
    return res.status(502).json({ error: `Scoring failed: ${err.message}`, scoringError: true });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.use((error, _req, res, next) => {
  if (error?.status === 403 && error.message === 'CORS origin is not allowed.') {
    return res.status(403).json({ error: error.message });
  }
  return next(error);
});

async function fetchWalletScoreForCase(address) {
  return fetchWalletScore(address);
}

const cases = createCaseRouter({ config, auth, fetchWalletScore: fetchWalletScoreForCase });
app.get('/api/cases', ...cases.guard, cases.listCases);
app.post('/api/cases', ...cases.guard, cases.createCase);
app.get('/api/cases/:caseId', ...cases.guard, cases.getCase);
app.patch('/api/cases/:caseId', ...cases.guard, cases.transitionCase);

module.exports = { app, config, fetchWalletScore };

if (require.main === module) app.listen(PORT, () => {
  console.log(`FlowTrace backend running in ${config.mode} mode at http://localhost:${PORT}`);
  console.log(`OpenRouter API key: ${process.env.OPENROUTER_API_KEY ? 'YES' : 'NO — add to backend/.env'}`);
  console.log(`Alchemy API key:    ${process.env.ALCHEMY_API_KEY    ? 'YES' : 'NO — add to backend/.env'}`);
});
