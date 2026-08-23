# FlowTrace Supabase migrations

`migrations/20260822000000_stage_1_tenancy_and_cases.sql` is the Stage 1
database migration. Apply it to the FlowTrace Supabase project through the
Supabase SQL editor or the Supabase CLI once the project is connected.

For the invitation-only v1 workflow, an operator creates a pending row in
`public.organization_invitations` and sends the matching email address a
Supabase Auth invite. No application admin UI exists yet by design.

`tests/stage_1_acceptance.sql` is a transactional acceptance-test script. It
rolls back its data after execution. Before running it, create four confirmed
test users in Supabase Auth and replace the four placeholder UUIDs at the top
of the script.
