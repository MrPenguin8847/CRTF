# FlowTrace
**Wallet Risk Intelligence for Law Enforcement Investigators**

FlowTrace is a web application that helps investigators rapidly assess cryptocurrency
wallet risk, trace transaction flows, and generate case-ready reports — without
requiring deep blockchain expertise.

> **Scope note**: FlowTrace is an investigative demonstration system. Risk scores are
> heuristic leads generated from a sampled window of on-chain activity — they are not
> legal proof, and identifying the person behind a wallet requires exchange KYC data
> obtained through legal process.

## What It Actually Does

* **Live Ethereum data** — wallet balances and transfer history are fetched in real
  time from [Alchemy](https://www.alchemy.com/) (`eth-mainnet`, `alchemy_getAssetTransfers`
  + `eth_getBalance`). The five example addresses listed below resolve to live data;
  a small built-in mock set exists only so the demo works offline.
* **Live OFAC sanctions screening** — the backend polls the official OFAC SDN XML
  export (default every 6 hours), extracts sanctioned Ethereum addresses, and feeds
  them into scoring at request time. There is no hardcoded sanctions list.
* **Server-authoritative risk scoring** (`backend/riskScoring.js`) — a deterministic
  0–100 score from four signals: sanctioned-address exposure (+50), fan-in structuring
  pattern (+15), rapid fan-out within 24h (+15), high hourly velocity (+10). Clients
  cannot submit or alter scores; every flagged case persists the score, flags, and a
  full wallet snapshot server-side.
* **Multi-tenant case management** — organizations, memberships, and cases live in
  Postgres (Supabase) behind row-level security. Case mutations go exclusively through
  `security definer` RPCs callable only by the backend's service role, and every
  transition writes an immutable `case_events` audit row (actor, timestamp, note).
  The flag-time investigator note is preserved verbatim; transition rationale is
  recorded separately in the event log.
* **Invitation-only auth** — there is no public sign-up. Accounts are created from
  Supabase Auth invites; pending organization invitations are claimed via a
  rate-limited backend endpoint backed by a database RPC. Operators manage
  invitations manually (see `supabase/README.md`); no admin UI exists yet by design.
* **AI investigative assistant** — a chat panel that explains the current wallet's
  risk factors in plain English, proxied through OpenRouter. Wallet context sent to
  the provider is disclosed in the panel footer. Falls back to scripted keyword
  answers if the upstream call fails.
* **One-click investigation reports** — structured PDF export (jsPDF) with score,
  band, flagged reasons, metadata, and the legal disclaimer above.

## Demo vs Production Mode

`FLOWTRACE_MODE` controls who can reach the analysis endpoints:

| Surface | `demo` | `production` |
|---|---|---|
| `GET /api/wallet/:address(/score)` | Anonymous allowed (IP rate-limited) | Requires authenticated session **and** active organization membership |
| `POST /api/assistant` | Anonymous allowed (IP rate-limited) | Same as above |
| `/api/cases/*` (all methods) | Requires authentication + active organization — in **both** modes | Same |
| Mock dataset fallback | Active for the five example addresses | Never (live Alchemy path always used) |

In both modes, active organization is derived server-side from verified membership
rows; a client-supplied organization header is honored only if it matches one.

## Tech Stack

* **Frontend** — vanilla HTML/CSS/JS single page (`index.html`); Supabase JS client
  (public anon key only) for session management; jsPDF for report export.
* **Backend** — Node.js + Express (`backend/`): config validation, session
  verification, per-user/IP rate limiting, Alchemy fetcher with response caching and
  request coalescing, OFAC feed poller with stale-tolerant snapshotting, case router.
* **Database/Auth** — Supabase (Postgres + Auth + RLS). Schema and policies:
  `supabase/migrations/`.
* **AI** — OpenRouter proxy (Anthropic Claude by default).

## Getting Started

### Prerequisites

* Node.js v18+
* A [Supabase](https://supabase.com/) project (auth + database)
* An [Alchemy](https://www.alchemy.com/) API key (Ethereum mainnet)
* An [OpenRouter](https://openrouter.ai/) API key (for the AI assistant)

### Database Setup

Apply the migrations in order through the Supabase SQL editor or CLI:

1. `supabase/migrations/20260822000000_stage_1_tenancy_and_cases.sql`
2. `supabase/migrations/20260823000000_stage_3_case_mutations.sql`
3. `supabase/migrations/20260824000000_stage_4_preserve_case_note.sql`

See `supabase/README.md` for the invitation workflow and acceptance-test script.

### Installation & Configuration

1. **Clone the repository:**
   ```bash
   git clone https://github.com/MrPenguin8847/CRTF.git
   cd CRTF/backend
   npm install
   ```

2. **Configure environment variables** — copy `.env.example` to `.env` and fill in:

   **Required (the server refuses to boot without these):**

   | Variable | Purpose |
   |---|---|
   | `FLOWTRACE_MODE` | `demo` or `production` (see table above) |
   | `SUPABASE_URL` | Your project URL, e.g. `https://xyz.supabase.co` |
   | `SUPABASE_ANON_KEY` | Public anon key (safe for browser use) |
   | `SUPABASE_SERVICE_ROLE_KEY` | Service-role key — **server-side only, never expose** |
   | `ALCHEMY_API_KEY` | Ethereum mainnet RPC access |
   | `ALLOWED_ORIGINS` | Comma-separated browser origins allowed by CORS; wildcards rejected |

   **Optional (required for AI features; server boots without it):**

   | Variable | Purpose |
   |---|---|
   | `OPENROUTER_API_KEY` | Enables `/api/assistant`; without it that endpoint returns 503 |

   **Tunables (sensible defaults shown in `.env.example`):**
   `PORT` (3000), `TRUST_PROXY` (off — set `1`/`true` only behind a trusted reverse
   proxy), `WALLET_RATE_LIMIT_WINDOW_MS`/`_MAX` (60 s / 30),
   `ASSISTANT_RATE_LIMIT_WINDOW_MS`/`_MAX` (60 s / 10),
   `INVITATION_RATE_LIMIT_WINDOW_MS`/`_MAX` (60 s / 10),
   `SANCTIONS_FEED_URL` (official OFAC SDN XML),
   `SANCTIONS_FEED_REFRESH_MS` (6 h), `SANCTIONS_FEED_REQUEST_TIMEOUT_MS` (15 s).

3. **Start the server:**
   ```bash
   npm start
   ```

4. **Open the app:** visit `http://localhost:3000`. Sign-in requires an account
   provisioned from an organization invitation (see `supabase/README.md`).

### Example Addresses

These resolve against **live Alchemy data** in production mode (and in demo mode
when no mock matches):

* `0x7fC2a9B4d8E1c6A3f0D5b7E9a1C4d6F8b2E0a3C7`
* `0xC4e7A1d9F2b6c8E0a5D3f7B1c9A4e6D8b0F2a7C1`
* `0x9aD3f6C1b8E4a0F7d2C5b9E1a6D8c3F0b4A7e2D5`
* `0xE1b5C9a2F7d3A8c0B6e4D1f9A3c7E2b5D8f0a6C4`
* `0xA6d0F3b8C1e7D4a9F2c5B0e6D8a1C7f4B9d3E0a2`

## Tests

From `backend/` (stages 2/3/5 hit real Supabase/Alchemy/OFAC and need `.env`):

```bash
npm run test:stage2              # auth + organization selection contracts
npm run test:stage3              # case lifecycle + audit trail against live DB
npm run test:stage4:contract     # fast local frontend/server contract check (no external calls)
npm run test:stage5:real         # real Alchemy-backed scoring end-to-end
npm run test:stage6:live         # live OFAC feed parse + scoring integration
node tests/batch1_verification.js # cache normalization + request coalescing (no external calls)
```

## Known Limitations

* Scoring operates on the most recent ~100 transfers per direction (Alchemy page
  size), not full history.
* Token USD equivalents are hardcoded pegs (`backend/riskScoring.js`); unlisted
  tokens are excluded from value-based math.
* Caches and rate limits are in-memory per process; multi-instance deployments need
  a shared store.
* Sanctions screening covers addresses appearing in the OFAC SDN feed only.
