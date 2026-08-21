'use strict';

// ── Token USD-equivalent table ────────────────────────────────────────────────
// Hardcoded rough pegs. Update before demo if ETH price moves significantly.
// Any token NOT in this table gets usdValue = 0 and is excluded from all
// value-based math (fan-in median, graph volume ranking). This is intentional:
// unlisted tokens are almost always spam airdrops, and the spam filter below
// should have removed them anyway. Belt-and-suspenders.
const TOKEN_USD = {
  ETH:  2500,
  WETH: 2500,
  USDT: 1,
  USDC: 1,
  DAI:  1,
  BUSD: 1,
  WBTC: 65000,
};

function toUsd(value, asset) {
  const rate = TOKEN_USD[(asset || '').toUpperCase()];
  if (!rate || !value) return 0;
  return (Number(value) || 0) * rate;
}

// ── OFAC Tornado Cash sanctioned contract addresses ────────────────────────────
// Source: U.S. Treasury OFAC SDN designation, August 8 2022.
// https://home.treasury.gov/news/press-releases/jy0916
// PRODUCTION NOTE: Replace this hardcoded list with a live OFAC SDN feed
// (e.g. polled daily from https://www.treasury.gov/ofac/downloads/sdn.xml
// or a commercial compliance API) before deploying to production.
const FLAGGED_ADDRESSES = new Set([
  '0x8589427373d6d84e98730d7795d8f6f8731fda0',  // Tornado Cash Router
  '0x722122df12d4e14e13ac3b6895a86e84145b6967',  // Tornado Cash 0.1 ETH
  '0xdd4c48c0b24039969fc16d1cdf626eab821d3384',  // Tornado Cash 0.1 ETH (v2)
  '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b',  // Tornado Cash 1 ETH
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf',  // Tornado Cash 10 ETH
]);

// ── Spam token filter ─────────────────────────────────────────────────────────
// Returns true if the transfer should be EXCLUDED from scoring signals.
// Kept in the raw transfer list for display; excluded from every calculation.
const SPAM_PATTERNS = [
  /https?:\/\//i,
  /\.(com|org|net|io|xyz|finance|app|pro|win|site)\b/i,
  /claim/i,
  /airdrop/i,
  /visit/i,
  /free/i,
  /reward/i,
];

function isSpam(transfer) {
  const sym = (transfer.asset || '').trim();
  if (!sym) return true;            // no symbol → spam
  if (sym.length > 16) return true; // absurdly long symbol → spam
  return SPAM_PATTERNS.some(rx => rx.test(sym));
}

// ── Median helper ─────────────────────────────────────────────────────────────
function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ── Main scoring function ─────────────────────────────────────────────────────
/**
 * scoreWallet(walletData)
 *
 * @param {object} walletData   Response shape from GET /api/wallet/:address
 *   { address, balanceEth, totalTransfers, transfers: [{hash,from,to,value,asset,category,timestamp}] }
 * @returns {{ score: number, band: string, flags: Array<{label,severity,explanation}>, graph: object }}
 */
function scoreWallet(walletData) {
  const { address, balanceEth, totalTransfers, transfers = [] } = walletData;
  const centerAddr = (address || '').toLowerCase();

  // ── 1. Separate spam from real ───────────────────────────────────────────
  const realTransfers = transfers.filter(t => !isSpam(t));

  // Categorise
  const incoming = realTransfers.filter(t => (t.to  || '').toLowerCase() === centerAddr);
  const outgoing = realTransfers.filter(t => (t.from || '').toLowerCase() === centerAddr);

  // ── 2. Signal: Flagged address exposure ──────────────────────────────────
  let flaggedAddressHit = false;
  let flaggedMatchAddr  = null;

  for (const t of realTransfers) {
    const from = (t.from || '').toLowerCase();
    const to   = (t.to   || '').toLowerCase();
    if (FLAGGED_ADDRESSES.has(from) || FLAGGED_ADDRESSES.has(to)) {
      flaggedAddressHit = true;
      flaggedMatchAddr  = FLAGGED_ADDRESSES.has(from) ? t.from : t.to;
      break;
    }
  }

  // ── 3. Signal: Fan-in ────────────────────────────────────────────────────
  // distinct senders ≥ 5 AND median incoming USD-equivalent < $125 (~0.05 ETH)
  const distinctSenders = new Set(
    incoming.map(t => (t.from || '').toLowerCase()).filter(Boolean)
  );
  const incomingUsd = incoming
    .map(t => toUsd(t.value, t.asset))
    .filter(v => v > 0);   // zero-value (unlisted token) excluded from median

  const medianInUsd = median(incomingUsd);
  const fanIn = distinctSenders.size >= 5
    && medianInUsd !== null
    && medianInUsd < 125;  // ~0.05 ETH at $2500/ETH

  // ── 4. Signal: Fan-out (sliding 24-hour window) ──────────────────────────
  // For each outgoing transfer t, count distinct recipient addresses in
  // the window [t.timestamp - 24h, t.timestamp].
  // O(n²) — acceptable for n ≤ 200 (maxCount 100 per direction).
  // Known limitation: only operates on the sampled window, not full history.
  const MS_24H = 24 * 60 * 60 * 1000;
  let fanOut = false;
  const outWithTs = outgoing
    .filter(t => t.timestamp)
    .map(t => ({ ...t, ms: new Date(t.timestamp).getTime() }))
    .filter(t => !isNaN(t.ms))
    .sort((a, b) => a.ms - b.ms);

  for (let i = 0; i < outWithTs.length && !fanOut; i++) {
    const windowEnd   = outWithTs[i].ms;
    const windowStart = windowEnd - MS_24H;
    const inWindow = outWithTs.filter(t => t.ms >= windowStart && t.ms <= windowEnd);
    const distinctRecipients = new Set(
      inWindow.map(t => (t.to || '').toLowerCase()).filter(Boolean)
    );
    if (distinctRecipients.size >= 5) fanOut = true;
  }

  // ── 5. Signal: Velocity (fixed clock-hour buckets) ───────────────────────
  // Group ALL real transfers by YYYY-MM-DDTHH bucket string.
  // Known limitation: a burst straddling an hour boundary (e.g. 12:50–1:10)
  // may split across two buckets. Acceptable for demo; the sliding-window
  // fan-out above catches rapid-burst cases more reliably.
  let highVelocity = false;
  const hourBuckets = new Map();
  for (const t of realTransfers) {
    if (!t.timestamp) continue;
    const bucket = t.timestamp.slice(0, 13); // "2024-03-15T14"
    hourBuckets.set(bucket, (hourBuckets.get(bucket) || 0) + 1);
  }
  for (const count of hourBuckets.values()) {
    if (count > 10) { highVelocity = true; break; }
  }

  // ── 6. Compute score ─────────────────────────────────────────────────────
  let score = 20;
  if (flaggedAddressHit) score += 50;
  if (fanIn)             score += 15;
  if (fanOut)            score += 15;
  if (highVelocity)      score += 10;
  score = Math.min(score, 100);

  const band = score >= 67 ? 'High Risk'
             : score >= 34 ? 'Moderate Risk'
             : 'Low Risk';

  // ── 7. Build flags array ──────────────────────────────────────────────────
  const flags = [];

  if (flaggedAddressHit) {
    const shortAddr = flaggedMatchAddr
      ? (flaggedMatchAddr.slice(0, 8) + '…' + flaggedMatchAddr.slice(-6))
      : 'a sanctioned address';
    flags.push({
      label:       'Linked to flagged address',
      severity:    'high',
      explanation: `This wallet transacted directly with ${shortAddr}, which is on the OFAC Tornado Cash sanctions list. Direct interaction with sanctioned contracts is a serious compliance red flag.`
    });
  }

  if (fanIn) {
    flags.push({
      label:       'Multiple small deposits from various sources',
      severity:    'medium',
      explanation: `${distinctSenders.size} distinct senders deposited into this wallet, with a median value of ~$${Math.round(medianInUsd)} per transfer. This pattern — many small inflows from different sources — is consistent with structuring or layering activity.`
    });
  }

  if (fanOut) {
    flags.push({
      label:       'Rapid fan-out to multiple addresses',
      severity:    'medium',
      explanation: `This wallet sent funds to 5 or more distinct recipients within a 24-hour window. Rapid dispersion to many addresses is a common layering technique to fragment a money trail.`
    });
  }

  if (highVelocity) {
    flags.push({
      label:       'Unusually high transaction velocity',
      severity:    'medium',
      explanation: `More than 10 transfers occurred within a single hour. Normal wallets rarely show this pattern; it may indicate automated activity or intentional rapid movement of funds.`
    });
  }

  // ── 8. Graph data ─────────────────────────────────────────────────────────
  // Sum USD-equivalent volume per counterparty, then pick top-2 inbound
  // and top-2 outbound by volume.
  const inboundVolume  = new Map(); // counterparty → total USD
  const outboundVolume = new Map();

  for (const t of realTransfers) {
    const usd  = toUsd(t.value, t.asset);
    const from = (t.from || '').toLowerCase();
    const to   = (t.to   || '').toLowerCase();

    if (to === centerAddr && from !== centerAddr) {
      inboundVolume.set(from, (inboundVolume.get(from) || 0) + usd);
    }
    if (from === centerAddr && to !== centerAddr) {
      outboundVolume.set(to, (outboundVolume.get(to) || 0) + usd);
    }
  }

  const topN = (map, n) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);

  const topIn  = topN(inboundVolume,  2);
  const topOut = topN(outboundVolume, 2);

  // Build nodes + edges
  const graphNodes = [
    { id: 'center', address, riskLevel: flaggedAddressHit ? 'high' : (score >= 67 ? 'high' : score >= 34 ? 'medium' : 'low') }
  ];
  const graphEdges = [];

  topIn.forEach(([addr, usd], i) => {
    const id = 'in' + i;
    graphNodes.push({
      id,
      address: addr,
      riskLevel: FLAGGED_ADDRESSES.has(addr.toLowerCase()) ? 'high' : 'low'
    });
    graphEdges.push({
      from:     id,
      to:       'center',
      valueEth: usd > 0 ? (usd / (TOKEN_USD.ETH || 2500)).toFixed(4) : '?',
      valueUsd: usd > 0 ? '$' + Math.round(usd).toLocaleString() : '?',
      dir:      'in'
    });
  });

  topOut.forEach(([addr, usd], i) => {
    const id = 'out' + i;
    graphNodes.push({
      id,
      address: addr,
      riskLevel: FLAGGED_ADDRESSES.has(addr.toLowerCase()) ? 'high' : 'low'
    });
    graphEdges.push({
      from:     'center',
      to:       id,
      valueEth: usd > 0 ? (usd / (TOKEN_USD.ETH || 2500)).toFixed(4) : '?',
      valueUsd: usd > 0 ? '$' + Math.round(usd).toLocaleString() : '?',
      dir:      'out'
    });
  });

  return {
    score,
    band,
    flags,
    graph: { nodes: graphNodes, edges: graphEdges }
  };
}

module.exports = { scoreWallet };
