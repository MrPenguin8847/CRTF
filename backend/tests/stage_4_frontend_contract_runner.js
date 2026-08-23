'use strict';

// Fast regression checks for the browser integration boundaries. Full visual
// interaction still belongs in a browser checkpoint; these checks ensure the
// shipped page keeps its auth/case wiring and that its server contract is safe.

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');

function loadEnv(filePath) {
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index > 0 && !line.trimStart().startsWith('#')) values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return values;
}

Object.assign(process.env, loadEnv(path.join(__dirname, '..', '.env')));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function withServer(mode, callback) {
  const previous = { PORT: process.env.PORT, FLOWTRACE_MODE: process.env.FLOWTRACE_MODE };
  const port = await freePort();
  process.env.PORT = String(port);
  process.env.FLOWTRACE_MODE = mode;
  delete require.cache[require.resolve('../server')];
  const { app } = require('../server');
  const server = await new Promise(resolve => {
    const instance = app.listen(port, '127.0.0.1', () => resolve(instance));
  });
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previous.PORT === undefined) delete process.env.PORT; else process.env.PORT = previous.PORT;
    if (previous.FLOWTRACE_MODE === undefined) delete process.env.FLOWTRACE_MODE; else process.env.FLOWTRACE_MODE = previous.FLOWTRACE_MODE;
    delete require.cache[require.resolve('../server')];
  }
}

async function response(baseUrl, pathname) {
  const result = await fetch(`${baseUrl}${pathname}`);
  const body = await result.json();
  return { status: result.status, body };
}

(async () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const script = page.slice(page.lastIndexOf('<script>') + 8, page.lastIndexOf('</script>'));
  new Function(script); // Syntax test independent of a browser runtime.

  assert.match(page, /cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2/);
  assert.match(script, /createClient\(appAuth\.config\.supabaseUrl, appAuth\.config\.supabaseAnonKey/);
  assert.match(script, /signInWithPassword/);
  assert.doesNotMatch(script, /\.auth\.signUp\s*\(/);
  assert.match(script, /verifyOtp\(\{ token_hash: params\.get\('token_hash'\), type: 'invite' \}/);
  assert.match(script, /claim-invitations/);
  assert.match(script, /if \(appAuth\.profile\.organizationSelectionRequired\)/);
  assert.match(script, /openAuthModal\('organization', memberships\)/);
  assert.match(script, /populateOrganizationSelect\(memberships\)/);
  assert.match(script, /function selectOrganization\(organizationId\)/);
  assert.match(script, /function confirmOrganizationSelection\(\)/);
  assert.match(script, /sessionStorage\.setItem\('flowtrace\.activeOrganizationId', organizationId\)/);
  assert.match(script, /headers\.set\('X-FlowTrace-Organization-Id', appAuth\.activeOrganizationId\)/);
  assert.match(script, /if \(isProductionMode\(\) && !appAuth\.session\)/);
  assert.match(script, /if \(!appAuth\.session\) \{ openAuthModal\(\); return; \}/);
  assert.match(script, /apiFetch\('\/api\/cases'/);
  assert.match(script, /transitionCase\(event, caseId, status\)/);
  assert.match(script, /snapshotToDisplayData\(savedCase\)/);
  assert.match(script, /currentViewIsSnapshot/);

  const production = await withServer('production', async baseUrl => {
    const config = await response(baseUrl, '/api/config');
    const wallet = await response(baseUrl, '/api/wallet/not-an-address');
    const cases = await response(baseUrl, '/api/cases');
    assert.equal(config.status, 200);
    assert.equal(config.body.mode, 'production');
    assert.ok(config.body.supabaseUrl && config.body.supabaseAnonKey);
    assert.equal(Object.keys(config.body).some(key => /service/i.test(key)), false);
    assert.equal(wallet.status, 401);
    assert.equal(cases.status, 401);
    return { publicConfigKeys: Object.keys(config.body), anonymousAnalysis: wallet.status, anonymousCases: cases.status };
  });

  const demo = await withServer('demo', async baseUrl => {
    const config = await response(baseUrl, '/api/config');
    const wallet = await response(baseUrl, '/api/wallet/not-an-address');
    assert.equal(config.body.mode, 'demo');
    assert.equal(wallet.status, 400); // reached validation: analysis is not auth-gated in demo.
    return { mode: config.body.mode, anonymousAnalysis: wallet.status };
  });

  console.log(JSON.stringify({ check: 'stage-4-frontend-contract', result: 'pass', production, demo }, null, 2));
})().catch(error => {
  console.log(JSON.stringify({ check: 'stage-4-frontend-contract', result: 'fail', error: error.stack || error.message }, null, 2));
  process.exitCode = 1;
});
