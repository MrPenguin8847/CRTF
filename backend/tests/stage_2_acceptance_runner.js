'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const checkName = process.argv[2];
const checks = new Set(['production-auth', 'demo-access', 'cors', 'rate-limit', 'credential-safety', 'organization-selection', 'inspect-expiry', 'expired-session', 'config-validation']);
if (!checks.has(checkName)) {
  throw new Error(`Usage: node stage_2_acceptance_runner.js <${[...checks].join('|')}>`);
}

function loadEnv(filePath) {
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0 && !line.trimStart().startsWith('#')) {
      values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return values;
}

Object.assign(process.env, loadEnv(path.join(__dirname, '..', '.env')));
const testTag = `stage2-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const projectUrl = process.env.SUPABASE_URL.replace(/\/$/, '');
const serviceHeaders = {
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};
const createdUserIds = [];
const createdOrganizationIds = [];

function emit(record) {
  const serialized = JSON.stringify(record);
  console.log(serialized);
  if (process.env.STAGE2_RESULT_FILE) {
    fs.writeFileSync(process.env.STAGE2_RESULT_FILE, serialized, 'utf8');
  }
}

async function supabaseRequest(resource, options = {}) {
  const response = await fetch(`${projectUrl}${resource}`, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_error) { body = text; }
  if (!response.ok) throw new Error(`${resource} failed with ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function createConfirmedUser(label) {
  const email = `flowtrace-${testTag}-${label}@example.test`;
  const password = `FlowTrace-${randomUUID()}-test-only`;
  const user = await supabaseRequest('/auth/v1/admin/users', {
    method: 'POST', headers: serviceHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  createdUserIds.push(user.id);
  return { id: user.id, email, password };
}

async function createOrganizationMembership(userId) {
  const organizationId = randomUUID();
  const organizationTag = `${testTag}-${organizationId.slice(0, 8)}`;
  createdOrganizationIds.push(organizationId);
  await supabaseRequest('/rest/v1/organizations', {
    method: 'POST',
    headers: { ...serviceHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ id: organizationId, name: `Stage 2 ${organizationTag}`, slug: `stage2-${organizationTag}` }),
  });
  await supabaseRequest('/rest/v1/organization_memberships', {
    method: 'POST',
    headers: { ...serviceHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ organization_id: organizationId, user_id: userId, role: 'investigator', status: 'active' }),
  });
  return organizationId;
}

async function passwordToken(user) {
  return supabaseRequest('/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
}

async function cleanup() {
  await Promise.all(createdOrganizationIds.map(async id => {
    await fetch(`${projectUrl}/rest/v1/organization_memberships?organization_id=eq.${id}`, {
      method: 'DELETE', headers: serviceHeaders,
    });
    await fetch(`${projectUrl}/rest/v1/organizations?id=eq.${id}`, {
      method: 'DELETE', headers: serviceHeaders,
    });
  }));
  await Promise.all(createdUserIds.map(id => fetch(`${projectUrl}/auth/v1/admin/users/${id}`, {
    method: 'DELETE', headers: serviceHeaders,
  })));
}

async function withServer(overrides, run) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = String(value);
  }
  const serverPath = require.resolve('../server');
  delete require.cache[serverPath];
  const { app } = require('../server');
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const port = server.address().port;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[serverPath];
  }
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_error) { body = text; }
  return { status: response.status, headers: Object.fromEntries(response.headers), body };
}

async function productionAuthCheck() {
  const member = await createConfirmedUser('member');
  const nonMember = await createConfirmedUser('non-member');
  const organizationId = await createOrganizationMembership(member.id);
  const memberSession = await passwordToken(member);
  const nonMemberSession = await passwordToken(nonMember);

  return withServer({ FLOWTRACE_MODE: 'production', WALLET_RATE_LIMIT_MAX: 20 }, async baseUrl => {
    const anonymousWallet = await request(baseUrl, '/api/wallet/not-an-address');
    const anonymousScore = await request(baseUrl, '/api/wallet/not-an-address/score');
    const anonymousAssistant = await request(baseUrl, '/api/assistant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userQuestion: 'test' }),
    });
    assert.equal(anonymousWallet.status, 401);
    assert.equal(anonymousScore.status, 401);
    assert.equal(anonymousAssistant.status, 401);

    const forged = await request(baseUrl, '/api/wallet/not-an-address', {
      headers: { Authorization: 'Bearer forged-token' },
    });
    assert.equal(forged.status, 401);

    const noMembership = await request(baseUrl, '/api/wallet/not-an-address', {
      headers: { Authorization: `Bearer ${nonMemberSession.access_token}` },
    });
    assert.equal(noMembership.status, 403);

    const memberResult = await request(baseUrl, '/api/wallet/not-an-address', {
      headers: { Authorization: `Bearer ${memberSession.access_token}` },
    });
    assert.equal(memberResult.status, 400);

    const profile = await request(baseUrl, '/api/auth/me', {
      headers: { Authorization: `Bearer ${memberSession.access_token}` },
    });
    assert.equal(profile.status, 200);
    assert.equal(profile.body.user.id, member.id);
    assert.deepEqual(profile.body.activeOrganization, { organizationId, role: 'investigator' });

    return {
      anonymousWallet: anonymousWallet.status,
      anonymousScore: anonymousScore.status,
      anonymousAssistant: anonymousAssistant.status,
      forged: forged.status,
      noMembership: noMembership.status,
      validMember: memberResult.status,
      profile: profile.status,
    };
  });
}

async function demoAccessCheck() {
  return withServer({ FLOWTRACE_MODE: 'demo', WALLET_RATE_LIMIT_MAX: 20 }, async baseUrl => {
    const anonymousWallet = await request(baseUrl, '/api/wallet/not-an-address');
    const anonymousScore = await request(baseUrl, '/api/wallet/not-an-address/score');
    assert.equal(anonymousWallet.status, 400);
    assert.equal(anonymousScore.status, 400);
    const invalidToken = await request(baseUrl, '/api/wallet/not-an-address', {
      headers: { Authorization: 'Bearer forged-token' },
    });
    assert.equal(invalidToken.status, 401);
    const accountEndpoint = await request(baseUrl, '/api/auth/me');
    assert.equal(accountEndpoint.status, 401);
    const casesEndpoint = await request(baseUrl, '/api/cases');
    assert.equal(casesEndpoint.status, 401);
    return {
      anonymousWallet: anonymousWallet.status,
      anonymousScore: anonymousScore.status,
      invalidToken: invalidToken.status,
      accountEndpoint: accountEndpoint.status,
      caseNamespace: casesEndpoint.status,
    };
  });
}

async function corsCheck() {
  return withServer({ FLOWTRACE_MODE: 'demo', WALLET_RATE_LIMIT_MAX: 20, ALLOWED_ORIGINS: 'https://app.flowtrace.test' }, async baseUrl => {
    const allowed = await request(baseUrl, '/api/wallet/not-an-address', {
      headers: { Origin: 'https://app.flowtrace.test' },
    });
    assert.equal(allowed.status, 400);
    assert.equal(allowed.headers['access-control-allow-origin'], 'https://app.flowtrace.test');

    const rejected = await request(baseUrl, '/api/wallet/not-an-address', {
      headers: { Origin: 'https://untrusted.example' },
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers['access-control-allow-origin'], undefined);
    return { allowedStatus: allowed.status, allowedOrigin: allowed.headers['access-control-allow-origin'], rejectedStatus: rejected.status };
  });
}

async function rateLimitCheck() {
  const member = await createConfirmedUser('rate-member');
  await createOrganizationMembership(member.id);
  const session = await passwordToken(member);
  return withServer({ FLOWTRACE_MODE: 'production', WALLET_RATE_LIMIT_MAX: 1, WALLET_RATE_LIMIT_WINDOW_MS: 60_000 }, async baseUrl => {
    const firstAnonymous = await request(baseUrl, '/api/wallet/not-an-address');
    const secondAnonymous = await request(baseUrl, '/api/wallet/not-an-address');
    assert.equal(firstAnonymous.status, 401);
    assert.equal(secondAnonymous.status, 429);
    assert.ok(secondAnonymous.headers['retry-after']);

    const authenticated = await request(baseUrl, '/api/wallet/not-an-address', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const authenticatedSecond = await request(baseUrl, '/api/wallet/not-an-address', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    assert.equal(authenticated.status, 400);
    assert.equal(authenticatedSecond.status, 429);
    return {
      firstAnonymous: firstAnonymous.status,
      secondAnonymous: secondAnonymous.status,
      retryAfter: secondAnonymous.headers['retry-after'],
      separateAuthenticatedKey: authenticated.status,
      authenticatedLimit: authenticatedSecond.status,
    };
  });
}

async function credentialSafetyCheck() {
  const alpha = await createConfirmedUser('credential-alpha');
  const bravo = await createConfirmedUser('credential-bravo');
  const alphaOrganizationId = await createOrganizationMembership(alpha.id);
  const bravoOrganizationId = await createOrganizationMembership(bravo.id);
  const alphaSession = await passwordToken(alpha);

  return withServer({ FLOWTRACE_MODE: 'production', WALLET_RATE_LIMIT_MAX: 20 }, async baseUrl => {
    const forged = await request(baseUrl, '/api/auth/me', {
      headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmb3JnZWQifQ.invalid' },
    });
    assert.equal(forged.status, 401);

    const crossOrganization = await request(baseUrl, '/api/auth/me', {
      headers: {
        Authorization: `Bearer ${alphaSession.access_token}`,
        'X-FlowTrace-Organization-Id': bravoOrganizationId,
      },
    });
    assert.equal(crossOrganization.status, 403);
    assert.notEqual(alphaOrganizationId, bravoOrganizationId);

    const deletedUser = await createConfirmedUser('deleted-session');
    const deletedSession = await passwordToken(deletedUser);
    const deleteResponse = await fetch(`${projectUrl}/auth/v1/admin/users/${deletedUser.id}`, {
      method: 'DELETE', headers: serviceHeaders,
    });
    assert.ok([200, 204].includes(deleteResponse.status));
    const revokedSession = await request(baseUrl, '/api/auth/me', {
      headers: { Authorization: `Bearer ${deletedSession.access_token}` },
    });
    assert.equal(revokedSession.status, 401);

    return {
      forged: forged.status,
      crossOrganizationStatus: crossOrganization.status,
      deletedSession: revokedSession.status,
    };
  });
}

async function organizationSelectionCheck() {
  const investigator = await createConfirmedUser('multi-organization');
  const firstOrganizationId = await createOrganizationMembership(investigator.id);
  const secondOrganizationId = await createOrganizationMembership(investigator.id);
  const session = await passwordToken(investigator);

  return withServer({ FLOWTRACE_MODE: 'production', WALLET_RATE_LIMIT_MAX: 20 }, async baseUrl => {
    const beforeSelection = await request(baseUrl, '/api/auth/me', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    assert.equal(beforeSelection.status, 200);
    assert.equal(beforeSelection.body.organizationSelectionRequired, true);
    assert.equal(beforeSelection.body.activeOrganization, null);
    assert.equal(beforeSelection.body.memberships.length, 2);

    const selected = await request(baseUrl, '/api/auth/me', {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'X-FlowTrace-Organization-Id': secondOrganizationId,
      },
    });
    assert.equal(selected.status, 200);
    assert.equal(selected.body.organizationSelectionRequired, false);
    assert.deepEqual(selected.body.activeOrganization, { organizationId: secondOrganizationId, role: 'investigator' });

    const cases = await request(baseUrl, '/api/cases', {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'X-FlowTrace-Organization-Id': secondOrganizationId,
      },
    });
    assert.equal(cases.status, 200);
    assert.deepEqual(cases.body.cases, []);

    return {
      organizationIds: [firstOrganizationId, secondOrganizationId],
      beforeSelection: {
        status: beforeSelection.status,
        organizationSelectionRequired: beforeSelection.body.organizationSelectionRequired,
        activeOrganization: beforeSelection.body.activeOrganization,
        memberships: beforeSelection.body.memberships,
      },
      selectedOrganization: { status: selected.status, activeOrganization: selected.body.activeOrganization },
      casesWithSelectedOrganizationHeader: { status: cases.status, count: cases.body.cases.length },
    };
  });
}

function decodeJwtPayload(token) {
  const payloadSegment = token.split('.')[1];
  if (!payloadSegment) throw new Error('Access token did not contain a JWT payload.');
  const padded = payloadSegment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - payloadSegment.length % 4) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

async function expiredSessionCheck() {
  const user = await createConfirmedUser('expired-session');
  const session = await passwordToken(user);
  const claims = decodeJwtPayload(session.access_token);
  if (!Number.isInteger(claims.exp)) throw new Error('Fresh access token did not contain an integer exp claim.');

  const waitMs = (claims.exp * 1000 - Date.now()) + 1_200;
  if (waitMs < 0) throw new Error('Fresh session token was already expired.');
  if (waitMs > 360_000) {
    throw new Error(`Fresh session expiry is ${Math.ceil(waitMs / 1000)} seconds away; the disposable project is not configured with the requested short test interval.`);
  }

  emit({
    check: 'expired-session',
    phase: 'waiting',
    issuedAtEpochSeconds: claims.iat,
    expiresAtEpochSeconds: claims.exp,
    lifetimeSeconds: claims.exp - claims.iat,
    waitMilliseconds: waitMs,
  });
  await new Promise(resolve => setTimeout(resolve, waitMs));
  return withServer({ FLOWTRACE_MODE: 'production', WALLET_RATE_LIMIT_MAX: 20 }, async baseUrl => {
    const expired = await request(baseUrl, '/api/auth/me', {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    assert.equal(expired.status, 401);
    return {
      issuedAtEpochSeconds: claims.iat,
      expiresAtEpochSeconds: claims.exp,
      waitedMilliseconds: waitMs,
      responseStatus: expired.status,
      responseError: expired.body?.error,
    };
  });
}

async function inspectExpiryCheck() {
  const user = await createConfirmedUser('inspect-expiry');
  const session = await passwordToken(user);
  const claims = decodeJwtPayload(session.access_token);
  if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) {
    throw new Error('Fresh access token did not contain integer iat and exp claims.');
  }
  return {
    issuedAtEpochSeconds: claims.iat,
    expiresAtEpochSeconds: claims.exp,
    lifetimeSeconds: claims.exp - claims.iat,
  };
}

function configValidationCheck() {
  const configPath = require.resolve('../config');
  delete require.cache[configPath];
  const { loadConfig } = require('../config');
  const originalMode = process.env.FLOWTRACE_MODE;
  const originalOrigins = process.env.ALLOWED_ORIGINS;
  try {
    process.env.FLOWTRACE_MODE = 'unsafe';
    assert.throws(loadConfig, /FLOWTRACE_MODE must be either/);
    process.env.FLOWTRACE_MODE = 'production';
    process.env.ALLOWED_ORIGINS = '*';
    assert.throws(loadConfig, /must not contain a wildcard/);
    return { invalidModeRejected: true, wildcardOriginRejected: true };
  } finally {
    process.env.FLOWTRACE_MODE = originalMode;
    process.env.ALLOWED_ORIGINS = originalOrigins;
  }
}

const runners = {
  'production-auth': productionAuthCheck,
  'demo-access': demoAccessCheck,
  cors: corsCheck,
  'rate-limit': rateLimitCheck,
  'credential-safety': credentialSafetyCheck,
  'organization-selection': organizationSelectionCheck,
  'inspect-expiry': inspectExpiryCheck,
  'expired-session': expiredSessionCheck,
  'config-validation': configValidationCheck,
};

(async () => {
  try {
    const evidence = await runners[checkName]();
    emit({ check: checkName, result: 'pass', evidence });
  } finally {
    await cleanup();
  }
})().catch(error => {
  emit({ check: checkName, result: 'fail', error: error.message });
  process.exitCode = 1;
});
