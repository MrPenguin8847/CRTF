'use strict';

const assert = require('assert/strict');
const { createWalletDataFetcher } = require('../walletData');

async function testCoalescing() {
  let calls = 0;
  const fetcher = createWalletDataFetcher({
    alchemyApiKey: 'test',
    fetchImpl: async (url, options) => {
      calls++;
      await new Promise(r => setTimeout(r, 50));
      const method = JSON.parse(options.body).method;
      if (method === 'eth_getBalance') return { ok: true, json: async () => ({ result: '0x0' }) };
      return { ok: true, json: async () => ({ result: { transfers: [] } }) };
    }
  });

  // Simultaneous calls for the same address
  const [d1, d2] = await Promise.all([
    fetcher('0x1111111111111111111111111111111111111111'),
    fetcher('0x1111111111111111111111111111111111111111')
  ]);

  assert.equal(calls, 3); // 3 calls per wallet (out, in, balance) - but only ONE set of 3 for two simultaneous requests
  console.log('✓ Request coalescing verified');
}

async function testCasing() {
  let calls = 0;
  const fetcher = createWalletDataFetcher({
    alchemyApiKey: 'test',
    fetchImpl: async (url, options) => {
      calls++;
      const method = JSON.parse(options.body).method;
      if (method === 'eth_getBalance') return { ok: true, json: async () => ({ result: '0x0' }) };
      return { ok: true, json: async () => ({ result: { transfers: [] } }) };
    }
  });

  // Letters are required so the case transformation is observable; only the
  // hex portion may be uppercased — '0X...' fails the /^0x[0-9a-f]{40}$/
  // validation and would exercise the rejection path instead of the cache.
  const addr = '0xabcdef0123456789abcdef0123456789abcdef01';
  await fetcher('0x' + addr.slice(2).toUpperCase());
  await fetcher(addr);

  assert.equal(calls, 3); // Second call should hit cache regardless of input casing
  console.log('✓ Casing normalization verified');
}

(async () => {
  try {
    await testCoalescing();
    await testCasing();
    console.log('BATCH 1 VERIFICATION PASSED');
  } catch (err) {
    console.error('BATCH 1 VERIFICATION FAILED:', err);
    process.exit(1);
  }
})();
