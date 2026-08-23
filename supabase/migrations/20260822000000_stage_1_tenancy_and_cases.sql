-- FlowTrace Stage 1: multi-tenant identity, invitations, cases, and RLS.
-- This migration is intended for a new Supabase project and is applied once.

create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  badge_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  slug text not null unique check (slug = lower(slug) and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_memberships (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('investigator', 'supervisor', 'org_admin')),
  status text not null default 'active' check (status in ('active', 'invited', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create index organization_memberships_user_organization_idx
  on public.organization_memberships (user_id, organization_id)
  where status = 'active';

-- DELIBERATE V1 LIMITATION: operators manage these invitation rows manually in
-- the Supabase dashboard; an admin invitation UI is intentionally deferred.
create table public.organization_invitations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  email text not null check (email = lower(email) and length(trim(email)) > 3),
  role text not null default 'investigator' check (role in ('investigator', 'supervisor', 'org_admin')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (status = 'accepted' and accepted_by is not null and accepted_at is not null)
    or (status <> 'accepted' and accepted_by is null and accepted_at is null)
  )
);

create unique index organization_invitations_one_pending_email_idx
  on public.organization_invitations (organization_id, email)
  where status = 'pending';

create index organization_invitations_pending_email_idx
  on public.organization_invitations (email, expires_at)
  where status = 'pending';

create index organization_invitations_created_by_idx
  on public.organization_invitations (created_by)
  where created_by is not null;

create index organization_invitations_accepted_by_idx
  on public.organization_invitations (accepted_by)
  where accepted_by is not null;

create table public.flagged_cases (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  wallet_address text not null check (
    wallet_address = lower(wallet_address)
    and wallet_address ~ '^0x[0-9a-f]{40}$'
  ),
  chain text not null default 'ethereum-mainnet' check (length(trim(chain)) > 0),
  risk_score smallint not null check (risk_score between 0 and 100),
  risk_band text not null check (risk_band in ('Low Risk', 'Moderate Risk', 'High Risk')),
  risk_flags jsonb not null default '[]'::jsonb check (jsonb_typeof(risk_flags) = 'array'),
  wallet_snapshot jsonb not null check (jsonb_typeof(wallet_snapshot) = 'object'),
  scoring_version text not null,
  sanctions_source text not null,
  sanctions_refreshed_at timestamptz,
  flagged_by uuid not null references auth.users(id) on delete restrict,
  flagged_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'dismissed', 'closed')),
  status_changed_by uuid not null references auth.users(id) on delete restrict,
  status_changed_at timestamptz not null default now(),
  case_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);

create unique index flagged_cases_one_open_wallet_idx
  on public.flagged_cases (organization_id, wallet_address, chain)
  where status = 'open';
-- CONFIRMED INTENTIONAL POLICY: The partial unique index only blocks duplicate OPEN cases.
-- A CLOSED or DISMISSED case for a wallet can be re-flagged as a new open case.
-- This behavior is fully intentional to allow re-investigations, as fresh risk signals
-- or transactions may arise on a previously closed wallet, requiring a new investigation trail.

create index flagged_cases_organization_status_flagged_idx
  on public.flagged_cases (organization_id, status, flagged_at desc);

create index flagged_cases_organization_wallet_idx
  on public.flagged_cases (organization_id, wallet_address, chain);

create index flagged_cases_flagged_by_idx
  on public.flagged_cases (flagged_by);

create index flagged_cases_status_changed_by_idx
  on public.flagged_cases (status_changed_by);

create table public.case_events (
  id uuid primary key default extensions.gen_random_uuid(),
  case_id uuid not null,
  organization_id uuid not null,
  event_type text not null check (event_type in ('flagged', 'dismissed', 'closed')),
  previous_status text check (previous_status in ('open', 'dismissed', 'closed')),
  new_status text not null check (new_status in ('open', 'dismissed', 'closed')),
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  event_note text,
  created_at timestamptz not null default now(),
  foreign key (case_id, organization_id)
    references public.flagged_cases (id, organization_id) on delete restrict,
  check (
    (event_type = 'flagged' and previous_status is null and new_status = 'open')
    or (event_type = 'dismissed' and previous_status = 'open' and new_status = 'dismissed')
    or (event_type = 'closed' and previous_status = 'open' and new_status = 'closed')
  )
);

create index case_events_case_created_idx
  on public.case_events (case_id, created_at);

create index case_events_organization_created_idx
  on public.case_events (organization_id, created_at desc);

create index case_events_actor_user_idx
  on public.case_events (actor_user_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger organizations_set_updated_at
before update on public.organizations
for each row execute function public.set_updated_at();

create trigger organization_memberships_set_updated_at
before update on public.organization_memberships
for each row execute function public.set_updated_at();

create trigger organization_invitations_set_updated_at
before update on public.organization_invitations
for each row execute function public.set_updated_at();

create trigger flagged_cases_set_updated_at
before update on public.flagged_cases
for each row execute function public.set_updated_at();

create or replace function public.is_active_organization_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships as membership
    where membership.organization_id = target_organization_id
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
  );
$$;

create or replace function public.claim_pending_organization_invitations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  invitation_email text;
  claimed_count integer := 0;
begin
  if (select auth.uid()) is null then
    raise exception 'An authenticated user is required to claim an invitation';
  end if;

  select lower(user_record.email)
    into invitation_email
  from auth.users as user_record
  where user_record.id = (select auth.uid())
    and user_record.email_confirmed_at is not null;

  if invitation_email is null then
    raise exception 'A confirmed email address is required to claim an invitation';
  end if;

  insert into public.profiles (user_id)
  values ((select auth.uid()))
  on conflict (user_id) do nothing;

  with claimed_invitations as (
    update public.organization_invitations as invitation
    set status = 'accepted',
        accepted_by = (select auth.uid()),
        accepted_at = now()
    where invitation.email = invitation_email
      and invitation.status = 'pending'
      and invitation.expires_at > now()
    returning invitation.organization_id, invitation.role
  ), inserted_memberships as (
    insert into public.organization_memberships (organization_id, user_id, role, status)
    select organization_id, (select auth.uid()), role, 'active'
    from claimed_invitations
    on conflict (organization_id, user_id) do nothing
    returning organization_id
  )
  select count(*) into claimed_count from inserted_memberships;

  update public.organization_invitations
  set status = 'expired'
  where email = invitation_email
    and status = 'pending'
    and expires_at <= now();

  return claimed_count;
end;
$$;

revoke all on function public.is_active_organization_member(uuid) from public;
grant execute on function public.is_active_organization_member(uuid) to authenticated;
revoke all on function public.claim_pending_organization_invitations() from public;
grant execute on function public.claim_pending_organization_invitations() to authenticated;

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.organization_invitations enable row level security;
alter table public.flagged_cases enable row level security;
alter table public.case_events enable row level security;

create policy profiles_select_own
on public.profiles for select to authenticated
using ((select auth.uid()) = user_id);

create policy profiles_insert_own
on public.profiles for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy profiles_update_own
on public.profiles for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy organizations_select_active_membership
on public.organizations for select to authenticated
using ((select public.is_active_organization_member(id)));

create policy organization_memberships_select_active_organization
on public.organization_memberships for select to authenticated
using ((select public.is_active_organization_member(organization_id)));

create policy flagged_cases_select_active_organization
on public.flagged_cases for select to authenticated
using ((select public.is_active_organization_member(organization_id)));

create policy case_events_select_active_organization
on public.case_events for select to authenticated
using ((select public.is_active_organization_member(organization_id)));

-- Case, invitation, organization, and membership mutations intentionally have
-- no browser-facing RLS policies. Stage 2/3 will perform them through verified
-- server endpoints so evidence-relevant fields cannot be supplied by clients.

