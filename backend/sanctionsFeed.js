'use strict';

const nodeFetch = require('node-fetch');
const ETHEREUM_ADDRESS = /\b0x[a-fA-F0-9]{40}\b/g;

function parseEthereumAddresses(xml) {
  if (typeof xml !== 'string') throw new Error('Sanctions feed was not text.');
  const addresses = new Set();
  for (const match of xml.matchAll(ETHEREUM_ADDRESS)) addresses.add(match[0].toLowerCase());
  if (addresses.size === 0) throw new Error('Sanctions feed contained no Ethereum addresses.');
  return addresses;
}

function createSanctionsFeed({ feedUrl, refreshMs, requestTimeoutMs = 15_000, fetchImpl = nodeFetch, now = () => Date.now() }) {
  let snapshot = null;
  let refreshPromise = null;

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
      let response;
      try {
        response = await fetchImpl(feedUrl, {
          headers: { Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1' }, signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new Error(`OFAC feed request timed out after ${requestTimeoutMs}ms.`);
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(`OFAC feed returned HTTP ${response.status}.`);
      const addresses = parseEthereumAddresses(await response.text());
      snapshot = {
        addresses,
        source: 'ofac-sdn-live-v1',
        feedUrl,
        refreshedAt: new Date(now()).toISOString(),
        expiresAt: now() + refreshMs,
        lastRefreshError: null,
      };
      return snapshot;
    })();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  async function getSnapshot() {
    if (snapshot && now() < snapshot.expiresAt) return { ...snapshot, stale: false };
    try {
      const fresh = await refresh();
      return { ...fresh, stale: false };
    } catch (error) {
      if (!snapshot) throw new Error(`Live sanctions feed is unavailable: ${error.message}`);
      snapshot.lastRefreshError = error.message;
      return { ...snapshot, stale: true };
    }
  }

  return { getSnapshot, refresh, parseEthereumAddresses };
}

module.exports = { createSanctionsFeed, parseEthereumAddresses };
