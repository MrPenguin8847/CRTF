'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { createWalletDataFetcher } = require('../walletData');
const { createSanctionsFeed } = require('../sanctionsFeed');
const { scoreWallet } = require('../riskScoring');

function jsonResponse(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

async function stage5() {
  const calls = [];
  const fetchWalletData = createWalletDataFetcher({
    alchemyApiKey: 'test-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      const method = JSON.parse(options.body).method;
      if (method === 'eth_getBalance') return jsonResponse({ result: '0xde0b6b3a7640000' });
      return jsonResponse({ result: { transfers: [] } });
    },
  });
  const data = await fetchWalletData('0x1111111111111111111111111111111111111111');
  assert.equal(data.balanceEth, 1);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.url.startsWith('https://eth-mainnet.g.alchemy.com/v2/')));
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(serverSource, /fetch\s*\(\s*`https?:\/\/(?:127\.0\.0\.1|localhost).*\/api\/wallet/);
  return { alchemyRequests: calls.length, sharedFetcherUrl: calls[0].url.replace('test-key', '[redacted]'), serverSelfFetchPresent: false };
}

async function stage6() {
  let nowMs = 1_700_000_000_000;
  let shouldFail = false;
  const liveAddress = '0x722122df12d4e14e13ac3b6895a86e84145b6967';
  const feed = createSanctionsFeed({
    feedUrl: 'https://ofac.example.test/SDN.XML', refreshMs: 1_000, requestTimeoutMs: 1_000,
    now: () => nowMs,
    fetchImpl: async () => {
      if (shouldFail) throw new Error('simulated upstream outage');
      return { ok: true, status: 200, text: async () => `<sdnList><id>${liveAddress}</id><id>0x1111111111111111111111111111111111111111</id></sdnList>` };
    },
  });
  const fresh = await feed.getSnapshot();
  assert.equal(fresh.source, 'ofac-sdn-live-v1');
  assert.equal(fresh.addresses.size, 2);
  assert.equal(fresh.addresses.has(liveAddress), true);
  const scored = scoreWallet({
    address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', balanceEth: 0, totalTransfers: 1,
    transfers: [{ from: liveAddress, to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', value: 1, asset: 'ETH', timestamp: '2026-01-01T00:00:00Z' }],
  }, fresh);
  assert.equal(scored.score, 70);
  assert.equal(scored.flags[0].label, 'Linked to flagged address');
  nowMs += 1_001;
  shouldFail = true;
  const stale = await feed.getSnapshot();
  assert.equal(stale.stale, true);
  assert.equal(stale.addresses.has(liveAddress), true);
  return {
    freshSnapshot: { source: fresh.source, addressCount: fresh.addresses.size, refreshedAt: fresh.refreshedAt, stale: fresh.stale },
    scoringWithLiveFeedAddress: { score: scored.score, firstFlag: scored.flags[0].label },
    failedRefreshUsesLastKnownGoodSnapshot: { stale: stale.stale, preservedAddress: stale.addresses.has(liveAddress) },
  };
}

(async () => {
  console.log(JSON.stringify({ check: 'stage-5-6-local-acceptance', result: 'pass', stage5: await stage5(), stage6: await stage6() }, null, 2));
})().catch(error => {
  console.log(JSON.stringify({ check: 'stage-5-6-local-acceptance', result: 'fail', error: error.stack || error.message }, null, 2));
  process.exitCode = 1;
});
