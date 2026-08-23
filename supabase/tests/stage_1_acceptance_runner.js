'use strict';

// Executes one Stage 1 acceptance check against a disposable Supabase project.
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_DB_URL in
// backend/.env, plus the `pg` package (FLOWTRACE_PG_MODULE_DIR may point to it).

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const checkName = process.argv[2];
const validChecks = new Set([
  'rls-isolation',
  'role-elevation',
  'invitation-single-use',
  'open-case-uniqueness',
]);

if (!validChecks.has(checkName)) {
  throw new Error(`Usage: node stage_1_acceptance_runner.js <${[...validChecks].join('|')}>`);
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

const env = loadEnv(path.join(__dirname, '..', '..', 'backend', '.env'));
for (const required of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL']) {
  if (!env[required]) throw new Error(`${required} is required in backend/.env`);
}

const pgRoot = process.env.FLOWTRACE_PG_MODULE_DIR;
const { Client } = pgRoot ? require(path.join(pgRoot, 'pg')) : require('pg');
const testTag = `stage1-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const createdUsers = [];

async function createConfirmedUser(label) {
  const email = `flowtrace-${testTag}-${label}@example.test`;
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password: `FlowTrace-${randomUUID()}-test-only`,
      email_confirm: true,
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Could not create ${label}: ${response.status} ${body.msg || body.message || ''}`);
  const user = { id: body.id, email: body.email };
  createdUsers.push(user);
  return user;
}

async function removeCreatedUsers() {
  await Promise.all(createdUsers.map(async ({ id }) => {
    const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!response.ok) throw new Error(`Could not remove disposable test user ${id}: ${response.status}`);
  }));
}

async function withClient(run) {
  const client = new Client({
    connectionString: env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function assumeAuthenticatedRole(client, userId) {
  await client.query('set local role authenticated');
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
  await client.query("select set_config('request.jwt.claim.role', 'authenticated', true)");
}

async function runRlsIsolation() {
  const alpha = await createConfirmedUser('alpha-investigator');
  const bravo = await createConfirmedUser('bravo-investigator');
  return withClient(async (client) => {
    const alphaOrg = randomUUID();
    const bravoOrg = randomUUID();
    const alphaCase = randomUUID();
    const bravoCase = randomUUID();
    await client.query('begin');
    try {
      await client.query(
        'insert into public.organizations (id, name, slug) values ($1, $2, $3), ($4, $5, $6)',
        [alphaOrg, `Alpha ${testTag}`, `alpha-${testTag}`, bravoOrg, `Bravo ${testTag}`, `bravo-${testTag}`]
      );
      await client.query(
        'insert into public.organization_memberships (organization_id, user_id, role) values ($1, $2, $3), ($4, $5, $6)',
        [alphaOrg, alpha.id, 'investigator', bravoOrg, bravo.id, 'investigator']
      );
      const caseSql = `
        insert into public.flagged_cases (
          id, organization_id, wallet_address, risk_score, risk_band, risk_flags,
          wallet_snapshot, scoring_version, sanctions_source, flagged_by, status_changed_by
        ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)`;
      await client.query(caseSql, [
        alphaCase, alphaOrg, '0x1111111111111111111111111111111111111111', 80, 'High Risk', '[]',
        JSON.stringify({ address: '0x1111111111111111111111111111111111111111' }),
        'stage-1-test', 'stage-1-test', alpha.id, alpha.id,
      ]);
      await client.query(caseSql, [
        bravoCase, bravoOrg, '0x2222222222222222222222222222222222222222', 20, 'Low Risk', '[]',
        JSON.stringify({ address: '0x2222222222222222222222222222222222222222' }),
        'stage-1-test', 'stage-1-test', bravo.id, bravo.id,
      ]);
      await assumeAuthenticatedRole(client, alpha.id);
      const visible = await client.query('select id from public.flagged_cases order by id');
      assert.deepEqual(visible.rows.map((row) => row.id), [alphaCase]);
      await client.query('rollback');
      return { alphaVisibleCaseIds: visible.rows.map((row) => row.id), bravoCaseId: bravoCase };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  });
}

async function runRoleElevation() {
  const investigator = await createConfirmedUser('investigator');
  return withClient(async (client) => {
    const organizationId = randomUUID();
    await client.query('begin');
    try {
      await client.query('insert into public.organizations (id, name, slug) values ($1, $2, $3)', [
        organizationId, `Role test ${testTag}`, `role-test-${testTag}`,
      ]);
      await client.query(
        'insert into public.organization_memberships (organization_id, user_id, role) values ($1, $2, $3)',
        [organizationId, investigator.id, 'investigator']
      );
      await assumeAuthenticatedRole(client, investigator.id);
      const attemptedUpdate = await client.query(
        "update public.organization_memberships set role = 'org_admin' where organization_id = $1 and user_id = $2 returning role",
        [organizationId, investigator.id]
      );
      assert.equal(attemptedUpdate.rowCount, 0);
      const membership = await client.query(
        'select role from public.organization_memberships where organization_id = $1 and user_id = $2',
        [organizationId, investigator.id]
      );
      assert.equal(membership.rows[0].role, 'investigator');
      await client.query('rollback');
      return { attemptedRowsChanged: attemptedUpdate.rowCount, retainedRole: membership.rows[0].role };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  });
}

async function runInvitationSingleUse() {
  const invited = await createConfirmedUser('invited-user');
  return withClient(async (client) => {
    const organizationId = randomUUID();
    await client.query('begin');
    try {
      await client.query('insert into public.organizations (id, name, slug) values ($1, $2, $3)', [
        organizationId, `Invite test ${testTag}`, `invite-test-${testTag}`,
      ]);
      await client.query(
        'insert into public.organization_invitations (organization_id, email, role, expires_at) values ($1, $2, $3, now() + interval \'1 day\')',
        [organizationId, invited.email.toLowerCase(), 'investigator']
      );
      await assumeAuthenticatedRole(client, invited.id);
      const firstClaim = await client.query('select public.claim_pending_organization_invitations() as claimed');
      const secondClaim = await client.query('select public.claim_pending_organization_invitations() as claimed');
      assert.equal(firstClaim.rows[0].claimed, 1);
      assert.equal(secondClaim.rows[0].claimed, 0);
      const membership = await client.query(
        'select role, status from public.organization_memberships where organization_id = $1 and user_id = $2',
        [organizationId, invited.id]
      );
      assert.deepEqual(membership.rows, [{ role: 'investigator', status: 'active' }]);
      await client.query('rollback');
      return { firstClaim: firstClaim.rows[0].claimed, secondClaim: secondClaim.rows[0].claimed, membership: membership.rows[0] };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  });
}

async function runOpenCaseUniqueness() {
  const investigator = await createConfirmedUser('case-investigator');
  return withClient(async (client) => {
    const organizationId = randomUUID();
    const walletAddress = '0x3333333333333333333333333333333333333333';
    await client.query('begin');
    try {
      await client.query('insert into public.organizations (id, name, slug) values ($1, $2, $3)', [
        organizationId, `Case test ${testTag}`, `case-test-${testTag}`,
      ]);
      await client.query(
        'insert into public.organization_memberships (organization_id, user_id, role) values ($1, $2, $3)',
        [organizationId, investigator.id, 'investigator']
      );
      const caseSql = `
        insert into public.flagged_cases (
          organization_id, wallet_address, risk_score, risk_band, risk_flags,
          wallet_snapshot, scoring_version, sanctions_source, flagged_by, status_changed_by
        ) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)`;
      const values = [
        organizationId, walletAddress, 55, 'Moderate Risk', '[]', JSON.stringify({ address: walletAddress }),
        'stage-1-test', 'stage-1-test', investigator.id, investigator.id,
      ];
      await client.query(caseSql, values);
      await client.query('savepoint second_open_case');
      let duplicateErrorCode = null;
      try {
        await client.query(caseSql, values);
      } catch (error) {
        duplicateErrorCode = error.code;
        await client.query('rollback to savepoint second_open_case');
      }
      assert.equal(duplicateErrorCode, '23505');
      const openCases = await client.query(
        "select count(*)::integer as count from public.flagged_cases where organization_id = $1 and wallet_address = $2 and chain = 'ethereum-mainnet' and status = 'open'",
        [organizationId, walletAddress]
      );
      assert.equal(openCases.rows[0].count, 1);
      await client.query('rollback');
      return { duplicateErrorCode, remainingOpenCases: openCases.rows[0].count };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  });
}

const checks = {
  'rls-isolation': runRlsIsolation,
  'role-elevation': runRoleElevation,
  'invitation-single-use': runInvitationSingleUse,
  'open-case-uniqueness': runOpenCaseUniqueness,
};

(async () => {
  try {
    const evidence = await checks[checkName]();
    console.log(JSON.stringify({ check: checkName, result: 'pass', evidence }));
  } finally {
    await removeCreatedUsers();
  }
})().catch((error) => {
  console.error(JSON.stringify({ check: checkName, result: 'fail', error: error.message }));
  process.exitCode = 1;
});
