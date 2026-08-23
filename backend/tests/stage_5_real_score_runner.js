'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { randomUUID } = require('crypto');

function loadEnv(filePath) {
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0 && !line.trimStart().startsWith('#')) values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

Object.assign(process.env, loadEnv(path.join(__dirname, '..', '.env')));
const projectUrl = process.env.SUPABASE_URL.replace(/\/$/, '');
const serviceHeaders = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };
const tag = `stage5-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const created = { userId: null, organizationId: null };

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch (_error) { body = text; }
  if (!response.ok && options.throwOnError) throw new Error(`${url} failed with ${response.status}: ${JSON.stringify(body)}`);
  return { status: response.status, body };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(error => error ? reject(error) : resolve(port)); });
  });
}

async function cleanup() {
  if (created.organizationId) {
    await fetch(`${projectUrl}/rest/v1/organization_memberships?organization_id=eq.${created.organizationId}`, { method: 'DELETE', headers: serviceHeaders });
    await fetch(`${projectUrl}/rest/v1/organizations?id=eq.${created.organizationId}`, { method: 'DELETE', headers: serviceHeaders });
  }
  if (created.userId) await fetch(`${projectUrl}/auth/v1/admin/users/${created.userId}`, { method: 'DELETE', headers: serviceHeaders });
}

(async () => {
  let server;
  try {
    const email = `flowtrace-${tag}@example.test`;
    const password = `FlowTrace-${randomUUID()}-test-only`;
    const user = await request(`${projectUrl}/auth/v1/admin/users`, { method: 'POST', headers: serviceHeaders, body: JSON.stringify({ email, password, email_confirm: true }), throwOnError: true });
    created.userId = user.body.id;
    created.organizationId = randomUUID();
    await request(`${projectUrl}/rest/v1/organizations`, { method: 'POST', headers: { ...serviceHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ id: created.organizationId, name: `Stage 5 ${tag}`, slug: `stage5-${tag}` }), throwOnError: true });
    await request(`${projectUrl}/rest/v1/organization_memberships`, { method: 'POST', headers: { ...serviceHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ organization_id: created.organizationId, user_id: created.userId, role: 'investigator', status: 'active' }), throwOnError: true });
    const session = await request(`${projectUrl}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: process.env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }), throwOnError: true });
    const port = await freePort();
    const priorPort = process.env.PORT;
    const priorMode = process.env.FLOWTRACE_MODE;
    process.env.PORT = String(port);
    process.env.FLOWTRACE_MODE = 'production';
    delete require.cache[require.resolve('../server')];
    const { app } = require('../server');
    server = await new Promise(resolve => { const instance = app.listen(port, '127.0.0.1', () => resolve(instance)); });
    const score = await request(`http://127.0.0.1:${port}/api/wallet/0x722122df12d4e14e13ac3b6895a86e84145b6967/score`, {
      headers: { Authorization: `Bearer ${session.body.access_token}`, 'X-FlowTrace-Organization-Id': created.organizationId },
    });
    assert.equal(score.status, 200, JSON.stringify(score.body));
    assert.equal(score.body.sanctions.source, 'ofac-sdn-live-v1');
    assert.equal(score.body.sanctions.stale, false);
    assert.ok(score.body.sanctions.addressCount > 0);
    console.log(JSON.stringify({
      check: 'stage-5-real-production-score', result: 'pass',
      evidence: { status: score.status, walletAddress: score.body.address, riskScore: score.body.scoring.score, sanctions: score.body.sanctions },
    }, null, 2));
    if (priorPort === undefined) delete process.env.PORT; else process.env.PORT = priorPort;
    if (priorMode === undefined) delete process.env.FLOWTRACE_MODE; else process.env.FLOWTRACE_MODE = priorMode;
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await cleanup();
  }
})().catch(error => {
  console.log(JSON.stringify({ check: 'stage-5-real-production-score', result: 'fail', error: error.stack || error.message }, null, 2));
  process.exitCode = 1;
});
