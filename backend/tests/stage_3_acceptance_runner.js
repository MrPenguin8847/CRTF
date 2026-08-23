'use strict';

// Exercises the Stage 3 API end-to-end using a local production-mode Express
// process and a disposable Supabase tenant. It intentionally sends forged
// client-side scoring fields and reads the persisted records back with the
// service role so the emitted result is reviewable acceptance evidence.

const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { randomUUID } = require('crypto');

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
for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ALCHEMY_API_KEY']) {
  if (!process.env[name]) throw new Error(`${name} is required in backend/.env`);
}

const projectUrl = process.env.SUPABASE_URL.replace(/\/$/, '');
const serviceHeaders = {
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};
const testTag = `stage3-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const created = { users: [], organizations: [], cases: [] };

function emit(record) {
  console.log(JSON.stringify(record, null, 2));
}

async function responseBody(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch (_error) { return text; }
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return { status: response.status, body: await responseBody(response) };
}

async function supabaseRequest(resource, options = {}) {
  const response = await fetch(`${projectUrl}${resource}`, options);
  const body = await responseBody(response);
  if (!response.ok) throw new Error(`${resource} failed with ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function createUserWithPassword(label) {
  const email = `flowtrace-${testTag}-${label}@example.test`;
  const password = `FlowTrace-${randomUUID()}-test-only`;
  const user = await supabaseRequest('/auth/v1/admin/users', {
    method: 'POST', headers: serviceHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  created.users.push(user.id);
  return { id: user.id, email, password };
}

async function addOrganizationMembership(userId, label) {
  const id = randomUUID();
  created.organizations.push(id);
  await supabaseRequest('/rest/v1/organizations', {
    method: 'POST', headers: { ...serviceHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ id, name: `Stage 3 ${label} ${testTag}`, slug: `stage3-${label}-${testTag}` }),
  });
  await supabaseRequest('/rest/v1/organization_memberships', {
    method: 'POST', headers: { ...serviceHeaders, Prefer: 'return=minimal' },
    body: JSON.stringify({ organization_id: id, user_id: userId, role: 'investigator', status: 'active' }),
  });
  return id;
}

async function passwordToken(user) {
  return supabaseRequest('/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: process.env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
}

function decodeJwtPayload(token) {
  const segment = token.split('.')[1];
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - segment.length % 4) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(port), FLOWTRACE_MODE: 'production', WALLET_RATE_LIMIT_MAX: '30' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10_000);
    const onOutput = chunk => {
      output += chunk.toString();
      if (output.includes('FlowTrace backend running')) {
        clearTimeout(timeout);
        resolve(server);
      }
    };
    server.stdout.on('data', onOutput);
    server.stderr.on('data', onOutput);
    server.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before becoming ready (code ${code}): ${output}`));
    });
  });
}

async function stopServer(server) {
  if (!server) return;
  if (server.exitCode !== null) return;
  await new Promise(resolve => {
    server.once('exit', resolve);
    server.kill();
  });
}

async function storedCase(caseId) {
  const rows = await supabaseRequest(`/rest/v1/flagged_cases?id=eq.${encodeURIComponent(caseId)}&select=id,organization_id,wallet_address,chain,risk_score,risk_band,risk_flags,wallet_snapshot,status,flagged_by,flagged_at,case_note`, {
    headers: serviceHeaders,
  });
  assert.equal(rows.length, 1, 'Expected exactly one stored case row.');
  return rows[0];
}

async function storedEvents(caseId) {
  return supabaseRequest(`/rest/v1/case_events?case_id=eq.${encodeURIComponent(caseId)}&select=event_type,previous_status,new_status,actor_user_id,event_note,created_at&order=created_at.asc`, {
    headers: serviceHeaders,
  });
}

function compactStoredCase(caseRow) {
  return {
    id: caseRow.id,
    organization_id: caseRow.organization_id,
    wallet_address: caseRow.wallet_address,
    chain: caseRow.chain,
    risk_score: caseRow.risk_score,
    risk_band: caseRow.risk_band,
    risk_flags: caseRow.risk_flags.map(flag => ({ label: flag.label, severity: flag.severity })),
    wallet_snapshot: {
      address: caseRow.wallet_snapshot.address,
      balanceEth: caseRow.wallet_snapshot.balanceEth,
      totalTransfers: caseRow.wallet_snapshot.totalTransfers,
      scoring: {
        score: caseRow.wallet_snapshot.scoring.score,
        band: caseRow.wallet_snapshot.scoring.band,
        flags: caseRow.wallet_snapshot.scoring.flags.map(flag => ({ label: flag.label, severity: flag.severity })),
      },
    },
    status: caseRow.status,
    flagged_by: caseRow.flagged_by,
    flagged_at: caseRow.flagged_at,
  };
}

function compactApiResponse(response) {
  if (!response.body?.case) return response;
  return { status: response.status, body: { case: compactStoredCase(response.body.case) } };
}

async function cleanup() {
  for (const caseId of created.cases) {
    await fetch(`${projectUrl}/rest/v1/case_events?case_id=eq.${encodeURIComponent(caseId)}`, { method: 'DELETE', headers: serviceHeaders });
    await fetch(`${projectUrl}/rest/v1/flagged_cases?id=eq.${encodeURIComponent(caseId)}`, { method: 'DELETE', headers: serviceHeaders });
  }
  for (const organizationId of created.organizations) {
    await fetch(`${projectUrl}/rest/v1/organization_memberships?organization_id=eq.${encodeURIComponent(organizationId)}`, { method: 'DELETE', headers: serviceHeaders });
    await fetch(`${projectUrl}/rest/v1/organizations?id=eq.${encodeURIComponent(organizationId)}`, { method: 'DELETE', headers: serviceHeaders });
  }
  for (const userId of created.users) {
    await fetch(`${projectUrl}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: serviceHeaders });
  }
}

async function run() {
  let phase = 'initialization';
  const port = await unusedPort();
  process.env.PORT = String(port);
  process.env.FLOWTRACE_MODE = 'production';
  process.env.WALLET_RATE_LIMIT_MAX = '30';
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    phase = 'create alpha user';
    const alpha = await createUserWithPassword('alpha');
    phase = 'create beta user';
    const beta = await createUserWithPassword('beta');
    phase = 'create alpha organization';
    const alphaOrganizationId = await addOrganizationMembership(alpha.id, 'alpha');
    phase = 'create beta organization';
    const betaOrganizationId = await addOrganizationMembership(beta.id, 'beta');
    phase = 'sign in alpha';
    const alphaToken = await passwordToken(alpha);
    phase = 'sign in beta';
    const betaToken = await passwordToken(beta);
    const jwt = decodeJwtPayload(alphaToken.access_token);
    const alphaHeaders = {
      Authorization: `Bearer ${alphaToken.access_token}`,
      'X-FlowTrace-Organization-Id': alphaOrganizationId,
      'Content-Type': 'application/json',
    };
    const betaHeaders = {
      Authorization: `Bearer ${betaToken.access_token}`,
      'X-FlowTrace-Organization-Id': betaOrganizationId,
      'Content-Type': 'application/json',
    };

    phase = 'start server';
    server = await startServer(port);

    // This address remains a stable live-data fixture, but its sanctions status
    // and resulting score are intentionally not treated as permanent test data.
    const testWallet = '0x722122df12d4e14e13ac3b6895a86e84145b6967';
    phase = 'verify authenticated profile';
    const authenticatedProfile = await request(baseUrl, '/api/auth/me', { headers: alphaHeaders });
    assert.equal(authenticatedProfile.status, 200, `Fresh authenticated profile request failed: ${JSON.stringify(authenticatedProfile.body)}`);
    phase = 'obtain live wallet score';
    const walletScore = await request(baseUrl, `/api/wallet/${testWallet}/score`, { headers: alphaHeaders });
    assert.equal(walletScore.status, 200, `Authenticated score request failed: ${JSON.stringify(walletScore.body)}`);
    assert.ok(walletScore.body.scoring.score >= 0 && walletScore.body.scoring.score <= 100);

    const forgedRequestBody = {
      walletAddress: testWallet,
      riskScore: 1,
      riskBand: 'Low Risk',
      riskFlags: [],
      walletSnapshot: { address: testWallet, scoring: { score: 1, band: 'Low Risk' } },
      note: 'Stage 3 server-authoritative snapshot test',
    };
    const createdCase = await request(baseUrl, '/api/cases', {
      method: 'POST', headers: alphaHeaders, body: JSON.stringify(forgedRequestBody),
    });
    assert.equal(createdCase.status, 201);
    created.cases.push(createdCase.body.case.id);
    const persistedSnapshotCase = await storedCase(createdCase.body.case.id);
    const createdScore = createdCase.body.case.risk_score;
    const createdBand = createdCase.body.case.risk_band;
    assert.ok(createdScore >= 0 && createdScore <= 100);
    assert.equal(persistedSnapshotCase.risk_score, createdScore);
    assert.notEqual(persistedSnapshotCase.risk_score, forgedRequestBody.riskScore);
    assert.equal(persistedSnapshotCase.risk_band, createdBand);
    assert.equal(persistedSnapshotCase.wallet_snapshot.scoring.score, createdScore);
    assert.equal(persistedSnapshotCase.case_note, forgedRequestBody.note);

    const duplicate = await request(baseUrl, '/api/cases', {
      method: 'POST', headers: alphaHeaders,
      body: JSON.stringify({ walletAddress: testWallet, riskScore: 0, note: 'Intentional duplicate API request' }),
    });
    assert.equal(duplicate.status, 409);

    const beforeRestart = await request(baseUrl, `/api/cases/${createdCase.body.case.id}`, { headers: alphaHeaders });
    assert.equal(beforeRestart.status, 200);
    await stopServer(server);
    server = await startServer(port);
    const afterRestart = await request(baseUrl, `/api/cases/${createdCase.body.case.id}`, { headers: alphaHeaders });
    assert.equal(afterRestart.status, 200);
    assert.equal(afterRestart.body.case.id, createdCase.body.case.id);
    assert.equal(afterRestart.body.case.status, 'open');

    const closed = await request(baseUrl, `/api/cases/${createdCase.body.case.id}`, {
      method: 'PATCH', headers: alphaHeaders,
      body: JSON.stringify({ status: 'closed', note: 'Stage 3 close transition' }),
    });
    assert.equal(closed.status, 200);
    const closedCaseAfterTransition = await storedCase(createdCase.body.case.id);
    const closedEvents = await storedEvents(createdCase.body.case.id);
    const closeEvent = closedEvents.find(event => event.event_type === 'closed');
    assert.equal(closedCaseAfterTransition.case_note, forgedRequestBody.note);
    assert.equal(closeEvent.event_note, 'Stage 3 close transition');

    const dismissWallet = '0xdd4c48c0b24039969fc16d1cdf626eab821d3384';
    const dismissedCase = await request(baseUrl, '/api/cases', {
      method: 'POST', headers: alphaHeaders,
      body: JSON.stringify({ walletAddress: dismissWallet, note: 'Stage 3 dismiss transition test' }),
    });
    assert.equal(dismissedCase.status, 201);
    created.cases.push(dismissedCase.body.case.id);
    const dismissed = await request(baseUrl, `/api/cases/${dismissedCase.body.case.id}`, {
      method: 'PATCH', headers: alphaHeaders,
      body: JSON.stringify({ status: 'dismissed', note: 'Stage 3 dismiss transition' }),
    });
    assert.equal(dismissed.status, 200);
    const dismissedEvents = await storedEvents(dismissedCase.body.case.id);
    assert.deepEqual(closedEvents.map(event => event.event_type), ['flagged', 'closed']);
    assert.deepEqual(dismissedEvents.map(event => event.event_type), ['flagged', 'dismissed']);

    const crossOrganizationGet = await request(baseUrl, `/api/cases/${createdCase.body.case.id}`, { headers: betaHeaders });
    assert.equal(crossOrganizationGet.status, 404);
    const forgedOrganizationSelection = await request(baseUrl, '/api/cases', {
      headers: { ...betaHeaders, 'X-FlowTrace-Organization-Id': alphaOrganizationId },
    });
    assert.equal(forgedOrganizationSelection.status, 403);

    return {
      check: 'stage-3-api-acceptance',
      result: 'pass',
      jwtLifetimeSeconds: jwt.exp - jwt.iat,
      serverAuthoritativeSnapshot: {
        scoringEngineResponse: { score: walletScore.body.scoring.score, band: walletScore.body.scoring.band },
        requestBodySent: forgedRequestBody,
        createResponse: compactApiResponse(createdCase),
        actualStoredRow: compactStoredCase(persistedSnapshotCase),
      },
      singleOpenCaseThroughApi: { firstResponse: compactApiResponse(createdCase), secondResponse: duplicate },
      survivesRestart: { beforeRestart: compactApiResponse(beforeRestart), afterRestart: compactApiResponse(afterRestart) },
      distinctDismissAndCloseAuditEvents: {
        closeTransition: compactApiResponse(closed),
        c10DatabaseEvidence: {
          beforeTransitionCaseNote: persistedSnapshotCase.case_note,
          afterTransitionCaseNote: closedCaseAfterTransition.case_note,
          transitionEventNote: closeEvent.event_note,
        },
        dismissTransition: compactApiResponse(dismissed),
        closeCaseEvents: closedEvents,
        dismissCaseEvents: dismissedEvents,
      },
      crossOrganizationRejected: { crossOrganizationGet, forgedOrganizationSelection },
    };
  } catch (error) {
    error.message = `${phase}: ${error.message}`;
    throw error;
  } finally {
    await stopServer(server);
    await cleanup();
  }
}

run().then(emit).catch(error => {
  emit({ check: 'stage-3-api-acceptance', result: 'fail', error: error.stack || error.message });
  process.exitCode = 1;
});
