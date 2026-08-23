-- Stage 4: preserve the original flag-time case_note on case transitions.
--
-- Audit-trail invariant: the case_note written by the flagging investigator at
-- flag time is the primary investigative record and must NOT be mutated by a
-- later dismiss/close transition. The transition rationale belongs in the
-- case_events.event_note column (already written below), where every status
-- change is logged with its own note, actor, and timestamp.
--
-- Before this migration, transition_flagged_case wrote the transition note
-- into flagged_cases.case_note via `case_note = coalesce(p_event_note, case_note)`,
-- silently overwriting the original flag-time note. That behaviour is removed
-- here: case_note is now treated as immutable post-creation. A subsequent
-- migration may add a separate supervisor_review_note column if a use case
-- emerges that requires persistent, mutable per-case notes outside the audit
-- log; until then, the audit log is the single source of truth.

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
  -- NOTE: case_note is intentionally not updated here. The original flag-time
  -- note written by the flagging investigator is preserved verbatim. The
  -- transition rationale is recorded below in case_events.event_note.
  update public.flagged_cases
  set status = p_new_status, status_changed_by = p_actor_user_id, status_changed_at = now()
  where id = p_case_id and organization_id = p_organization_id and status = 'open'
  returning * into updated_case;
  if not found then raise exception 'Open case not found in organization'; end if;
  insert into public.case_events (case_id, organization_id, event_type, previous_status, new_status, actor_user_id, event_note)
  values (p_case_id, p_organization_id, p_new_status, 'open', p_new_status, p_actor_user_id, p_event_note);
  return updated_case;
end;
$$;

-- Revoke must be repeated because CREATE OR REPLACE FUNCTION does not preserve
-- the privilege set when the function signature changes.
revoke all on function public.transition_flagged_case(uuid,uuid,text,uuid,text) from public;
