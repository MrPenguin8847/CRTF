'use strict';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function createWalletDataFetcher({ alchemyApiKey, fetchImpl, cacheTtlMs = 60_000 }) {
  if (!alchemyApiKey) throw new Error('ALCHEMY_API_KEY not configured on server.');
  const cache = new Map();
  const inFlight = new Map();
  const alchemyUrl = `https://eth-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;

  async function alchemyRpc(body) {
    const response = await fetchImpl(alchemyUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Alchemy HTTP ${response.status}: ${await response.text()}`);
    const payload = await response.json();
    if (payload.error) throw new Error(`Alchemy RPC error ${payload.error.code}: ${payload.error.message}`);
    return payload.result;
  }

  return async function fetchWalletData(address) {
    if (!ADDRESS.test(address)) throw new Error('Invalid Ethereum address.');
    const normalizedAddress = address.toLowerCase();
    
    const cached = cache.get(normalizedAddress);
    if (cached && Date.now() < cached.expiresAt) return { ...cached.data, _cached: true };

    const pending = inFlight.get(normalizedAddress);
    if (pending) return pending;

    const request = (async () => {
      const [outResult, inResult, balanceHex] = await Promise.all([
        alchemyRpc({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [{
          fromBlock: '0x0', fromAddress: normalizedAddress, category: ['external', 'erc20'], withMetadata: true,
          excludeZeroValue: true, maxCount: '0x64', order: 'desc',
        }] }),
        alchemyRpc({ jsonrpc: '2.0', id: 2, method: 'alchemy_getAssetTransfers', params: [{
          fromBlock: '0x0', toAddress: normalizedAddress, category: ['external', 'erc20'], withMetadata: true,
          excludeZeroValue: true, maxCount: '0x64', order: 'desc',
        }] }),
        alchemyRpc({ jsonrpc: '2.0', id: 3, method: 'eth_getBalance', params: [normalizedAddress, 'latest'] }),
      ]);

      const seen = new Set();
      const transfers = [];
      for (const tx of [...(outResult.transfers || []), ...(inResult.transfers || [])]) {
        const key = `${tx.hash}-${tx.asset || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        transfers.push({
          hash: tx.hash, from: tx.from, to: tx.to, value: tx.value, asset: tx.asset || 'ETH',
          category: tx.category, timestamp: tx.metadata?.blockTimestamp || null,
        });
      }
      transfers.sort((a, b) => {
        if (!a.timestamp) return 1;
        if (!b.timestamp) return -1;
        return b.timestamp.localeCompare(a.timestamp);
      });
      const data = {
        address: normalizedAddress,
        balanceEth: Number(BigInt(balanceHex)) / 1e18,
        totalTransfers: transfers.length,
        transfers,
      };
      cache.set(normalizedAddress, { data, expiresAt: Date.now() + cacheTtlMs });
      return data;
    })();

    inFlight.set(normalizedAddress, request);
    try {
      return await request;
    } finally {
      if (inFlight.get(normalizedAddress) === request) inFlight.delete(normalizedAddress);
    }
  };
}

module.exports = { createWalletDataFetcher, ADDRESS };
