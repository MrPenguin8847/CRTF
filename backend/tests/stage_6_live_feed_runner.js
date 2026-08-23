'use strict';

const fs = require('fs');
const path = require('path');
const { createSanctionsFeed } = require('../sanctionsFeed');
const { scoreWallet } = require('../riskScoring');

function loadEnv(filePath) {
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0 && !line.trimStart().startsWith('#')) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

Object.assign(process.env, loadEnv(path.join(__dirname, '..', '.env')));
const feedUrl = process.env.SANCTIONS_FEED_URL || 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';

(async () => {
  const feed = createSanctionsFeed({ feedUrl, refreshMs: 60_000, requestTimeoutMs: 15_000 });
  const snapshot = await feed.getSnapshot();
  const currentFeedAddress = [...snapshot.addresses][0];
  const scored = scoreWallet({
    address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', balanceEth: 0, totalTransfers: 1,
    transfers: [{ from: currentFeedAddress, to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', value: 1, asset: 'ETH', timestamp: '2026-01-01T00:00:00Z' }],
  }, snapshot);
  console.log(JSON.stringify({
    check: 'stage-6-live-ofac-feed',
    result: 'pass',
    evidence: {
      source: snapshot.source,
      feedUrl: snapshot.feedUrl,
      refreshedAt: snapshot.refreshedAt,
      addressCount: snapshot.addresses.size,
      currentFeedAddress,
      scoringWithCurrentFeedAddress: { score: scored.score, firstFlag: scored.flags[0]?.label },
      stale: snapshot.stale,
    },
  }, null, 2));
})().catch(error => {
  console.log(JSON.stringify({ check: 'stage-6-live-ofac-feed', result: 'fail', error: error.stack || error.message }, null, 2));
  process.exitCode = 1;
});
