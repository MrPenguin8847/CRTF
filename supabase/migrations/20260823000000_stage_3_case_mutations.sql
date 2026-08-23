-- Stage 3: atomic, server-only case creation and state transitions.
create or replace function public.create_flagged_case(
  p_organization_id uuid, p_wallet_address text, p_chain text, p_risk_score smallint,
  p_risk_band text, p_risk_flags jsonb, p_wallet_snapshot jsonb, p_scoring_version text,
  p_sanctions_source text, p_sanctions_refreshed_at timestamptz, p_flagged_by uuid,
  p_case_note text default null
) returns public.flagged_cases
language plpgsql security definer set search_path = '' as $$
declare created_case public.flagged_cases;
begin
  insert into public.flagged_cases (
    organization_id, wallet_address, chain, risk_score, risk_band, risk_flags,
    wallet_snapshot, scoring_version, sanctions_source, sanctions_refreshed_at,
    flagged_by, status_changed_by, case_note
  ) values (
    p_organization_id, p_wallet_address, p_chain, p_risk_score, p_risk_band, p_risk_flags,
    p_wallet_snapshot, p_scoring_version, p_sanctions_source, p_sanctions_refreshed_at,
    p_flagged_by, p_flagged_by, p_case_note
  ) returning * into created_case;

  insert into public.case_events (case_id, organization_id, event_type, new_status, actor_user_id, event_note)
  values (created_case.id, p_organization_id, 'flagged', 'open', p_flagged_by, p_case_note);
  return created_case;
end;
$$;

create or replace function public.transition_flagged_case(
  p_case_id uuid, p_organization_id uuid, p_new_status text, p_actor_user_id uuid,
  p_event_note text default null
) returns public.flagged_cases
language plpgsql security definer set search_path = '' as $$
declare updated_case public.flagged_cases;
begin
  if p_new_status not in ('dismissed', 'closed') then
    raise exception 'Only dismissed and closed are valid case transitions';
  end if;
  update public.flagged_cases
  set status = p_new_status, status_changed_by = p_actor_user_id, status_changed_at = now(), case_note = coalesce(p_event_note, case_note)
  where id = p_case_id and organization_id = p_organization_id and status = 'open'
  returning * into updated_case;
  if not found then raise exception 'Open case not found in organization'; end if;
  insert into public.case_events (case_id, organization_id, event_type, previous_status, new_status, actor_user_id, event_note)
  values (p_case_id, p_organization_id, p_new_status, 'open', p_new_status, p_actor_user_id, p_event_note);
  return updated_case;
end;
$$;

revoke all on function public.create_flagged_case(uuid,text,text,smallint,text,jsonb,jsonb,text,text,timestamptz,uuid,text) from public;
revoke all on function public.transition_flagged_case(uuid,uuid,text,uuid,text) from public;
