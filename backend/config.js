'use strict';

function requiredString(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured.`);
  return value;
}

function integerSetting(name, defaultValue, minimum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return value;
}

function parseAllowedOrigins(rawOrigins) {
  const origins = rawOrigins
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) throw new Error('ALLOWED_ORIGINS must include at least one origin.');
  if (origins.includes('*')) throw new Error('ALLOWED_ORIGINS must not contain a wildcard origin.');

  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
        throw new Error('origin must be an http(s) origin without a path');
      }
    } catch (_error) {
      throw new Error(`ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
    }
  }

  return origins;
}

function parseTrustProxy(rawValue) {
  if (rawValue === undefined || rawValue === '' || rawValue === '0' || rawValue === 'false') return false;
  if (rawValue === 'true') return 1;
  return integerSetting('TRUST_PROXY', 0, 1);
}

function loadConfig() {
  const mode = requiredString('FLOWTRACE_MODE');
  if (!['demo', 'production'].includes(mode)) {
    throw new Error('FLOWTRACE_MODE must be either "demo" or "production".');
  }

  const supabaseUrl = requiredString('SUPABASE_URL');
  try {
    new URL(supabaseUrl);
  } catch (_error) {
    throw new Error('SUPABASE_URL must be a valid URL.');
  }

  return Object.freeze({
    mode,
    port: integerSetting('PORT', 3000, 1),
    supabaseUrl,
    supabaseAnonKey: requiredString('SUPABASE_ANON_KEY'),
    supabaseServiceRoleKey: requiredString('SUPABASE_SERVICE_ROLE_KEY'),
    allowedOrigins: parseAllowedOrigins(requiredString('ALLOWED_ORIGINS')),
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    walletRateLimitWindowMs: integerSetting('WALLET_RATE_LIMIT_WINDOW_MS', 60_000, 1_000),
    walletRateLimitMax: integerSetting('WALLET_RATE_LIMIT_MAX', 30, 1),
    assistantRateLimitWindowMs: integerSetting('ASSISTANT_RATE_LIMIT_WINDOW_MS', 60_000, 1_000),
    assistantRateLimitMax: integerSetting('ASSISTANT_RATE_LIMIT_MAX', 10, 1),
    invitationRateLimitWindowMs: integerSetting('INVITATION_RATE_LIMIT_WINDOW_MS', 60_000, 1_000),
    invitationRateLimitMax: integerSetting('INVITATION_RATE_LIMIT_MAX', 10, 1),
    sanctionsFeedUrl: process.env.SANCTIONS_FEED_URL?.trim() || 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML',
    sanctionsFeedRefreshMs: integerSetting('SANCTIONS_FEED_REFRESH_MS', 6 * 60 * 60 * 1_000, 60_000),
    sanctionsFeedRequestTimeoutMs: integerSetting('SANCTIONS_FEED_REQUEST_TIMEOUT_MS', 15_000, 1_000),
  });
}

module.exports = { loadConfig };
