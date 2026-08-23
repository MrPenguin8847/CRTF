-- FlowTrace Stage 1 acceptance checks.
-- Run in a disposable Supabase project after applying the Stage 1 migration.
-- This script deliberately does not create auth.users records: create four
-- confirmed test users through Supabase Auth first, then replace the UUIDs.

begin;

-- Replace all four values with distinct confirmed auth.users UUIDs.
create temporary table stage_1_test_users (
  label text primary key,
  user_id uuid not null
) on commit drop;

insert into stage_1_test_users (label, user_id) values
  ('alpha_investigator', '00000000-0000-0000-0000-000000000001'),
  ('alpha_supervisor',   '00000000-0000-0000-0000-000000000002'),
  ('bravo_investigator', '00000000-0000-0000-0000-000000000003'),
  ('invited_user',       '00000000-0000-0000-0000-000000000004');

do $$
begin
  if exists (
    select 1 from stage_1_test_users where user_id::text like '00000000-%'
  ) then
    raise exception 'Replace the placeholder UUIDs with confirmed auth.users IDs before running this script';
  end if;
end;
$$;

insert into public.organizations (id, name, slug) values
  ('10000000-0000-0000-0000-000000000001', 'Alpha Investigations', 'alpha-investigations'),
  ('20000000-0000-0000-0000-000000000002', 'Bravo Investigations', 'bravo-investigations');

insert into public.organization_memberships (organization_id, user_id, role) values
  ('10000000-0000-0000-0000-000000000001', (select user_id from stage_1_test_users where label = 'alpha_investigator'), 'investigator'),
  ('10000000-0000-0000-0000-000000000001', (select user_id from stage_1_test_users where label = 'alpha_supervisor'), 'supervisor'),
  ('20000000-0000-0000-0000-000000000002', (select user_id from stage_1_test_users where label = 'bravo_investigator'), 'investigator');

insert into public.flagged_cases (
  id, organization_id, wallet_address, risk_score, risk_band, risk_flags,
  wallet_snapshot, scoring_version, sanctions_source, flagged_by,
  status_changed_by
) values
  (
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    '0x1111111111111111111111111111111111111111',
    80, 'High Risk', '[{"label":"test"}]'::jsonb, '{"address":"0x1111111111111111111111111111111111111111"}'::jsonb,
    'stage-1-test', 'stage-1-test',
    (select user_id from stage_1_test_users where label = 'alpha_investigator'),
    (select user_id from stage_1_test_users where label = 'alpha_investigator')
  ),
  (
    '40000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000002',
    '0x2222222222222222222222222222222222222222',
    20, 'Low Risk', '[]'::jsonb, '{"address":"0x2222222222222222222222222222222222222222"}'::jsonb,
    'stage-1-test', 'stage-1-test',
    (select user_id from stage_1_test_users where label = 'bravo_investigator'),
    (select user_id from stage_1_test_users where label = 'bravo_investigator')
  );

-- CHECK 1: two-organization RLS isolation. Run as Alpha's authenticated role;
-- only the Alpha row must be visible.
set local role authenticated;
select set_config('request.jwt.claim.sub', (select user_id::text from stage_1_test_users where label = 'alpha_investigator'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  visible_cases integer;
begin
  select count(*) into visible_cases from public.flagged_cases;
  if visible_cases <> 1 then
    raise exception 'RLS isolation failed: Alpha investigator saw % cases, expected 1', visible_cases;
  end if;
end;
$$;
reset role;

-- CHECK 2: role elevation prevention. Authenticated users have no UPDATE policy
-- on memberships, so Alpha cannot change their own investigator role.
set local role authenticated;
select set_config('request.jwt.claim.sub', (select user_id::text from stage_1_test_users where label = 'alpha_investigator'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  affected_rows integer;
begin
  update public.organization_memberships
  set role = 'org_admin'
  where organization_id = '10000000-0000-0000-0000-000000000001'
    and user_id = (select user_id from stage_1_test_users where label = 'alpha_investigator');
  get diagnostics affected_rows = row_count;
  if affected_rows <> 0 then
    raise exception 'Role-elevation test failed: % membership rows changed', affected_rows;
  end if;
end;
$$;
reset role;

-- CHECK 3: invitation single-use. Before this check, invite the fourth test
-- user through Supabase Auth and set their confirmed email to the address below.
insert into public.organization_invitations (id, organization_id, email, role, expires_at) values
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   lower((select email from auth.users where id = (select user_id from stage_1_test_users where label = 'invited_user'))),
   'investigator', now() + interval '1 day');

set local role authenticated;
select set_config('request.jwt.claim.sub', (select user_id::text from stage_1_test_users where label = 'invited_user'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  first_claim integer;
  second_claim integer;
begin
  select public.claim_pending_organization_invitations() into first_claim;
  select public.claim_pending_organization_invitations() into second_claim;
  if first_claim <> 1 then
    raise exception 'Invitation claim failed: first result %, expected 1', first_claim;
  end if;
  if second_claim <> 0 then
    raise exception 'Invitation was reusable: second result %, expected 0', second_claim;
  end if;
end;
$$;
reset role;

-- CHECK 4: the partial unique index prevents two open cases for one wallet in
-- one organization while allowing the original historical row to remain.
do $$
begin
  begin
    insert into public.flagged_cases (
      organization_id, wallet_address, risk_score, risk_band, risk_flags,
      wallet_snapshot, scoring_version, sanctions_source, flagged_by, status_changed_by
    ) values (
      '10000000-0000-0000-0000-000000000001',
      '0x1111111111111111111111111111111111111111',
      80, 'High Risk', '[]'::jsonb, '{}'::jsonb, 'stage-1-test', 'stage-1-test',
      (select user_id from stage_1_test_users where label = 'alpha_investigator'),
      (select user_id from stage_1_test_users where label = 'alpha_investigator')
    );
    raise exception 'Open-case uniqueness test failed: duplicate insert unexpectedly succeeded';
  exception when unique_violation then
    null;
  end;
end;
$$;

rollback;
