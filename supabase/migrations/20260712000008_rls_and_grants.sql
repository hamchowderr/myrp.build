-- ── Consolidated baseline 05: RLS + grants ───────────────────────────────────
-- Every table has RLS enabled. Tenant tables get SELECT-only policies for the
-- anon/JWT role (identity via auth.uid()/auth.email()); all writes go through the
-- SECURITY DEFINER RPCs in baseline 04 or the service role (which bypasses RLS),
-- so there are deliberately no INSERT/UPDATE/DELETE policies.
--
-- RLS only FILTERS rows — the `authenticated` role also needs a table-level
-- GRANT SELECT or a read 42501s (permission denied) BEFORE the policy is even
-- evaluated. So tenant read tables are granted SELECT to authenticated below.
-- No insert/update/delete grants are issued to anon/authenticated (writes are
-- definer-only). App RPCs have EXECUTE revoked from PUBLIC (so anon can't call
-- them) and re-granted to authenticated + service_role.
--
-- generation_logs and ox_corpus are service-role-only surfaces: RLS is enabled
-- with NO policy and all access is revoked from anon/authenticated, so only the
-- service role (and match_ox_corpus, which is SECURITY DEFINER) can touch them.

-- ── enable RLS on ALL tables ─────────────────────────────────────────────────
alter table public.app_users enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.billing_customers enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.usage_counters enable row level security;
alter table public.generation_logs enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.servers enable row level security;
alter table public.mastra_threads enable row level security;
alter table public.mastra_messages enable row level security;
alter table public.mastra_resources enable row level security;
alter table public.mastra_message_embeddings enable row level security;
alter table public.mastra_observational_memory enable row level security;
alter table public.ox_corpus enable row level security;

-- ── tenant SELECT policies (anon/JWT role; identity via auth.uid()) ──────────
create policy "read own user" on public.app_users
  for select using (id = (select auth.uid()));

create policy "read member workspaces" on public.workspaces
  for select using (public.is_workspace_member(id));

create policy "read own/ws memberships" on public.workspace_members
  for select using (
    user_id = (select auth.uid())
    or public.is_workspace_member(workspace_id)
  );

create policy "read ws billing customers" on public.billing_customers
  for select using (public.is_workspace_member(workspace_id));

create policy "read ws subscriptions" on public.billing_subscriptions
  for select using (public.is_workspace_member(public.get_customer_workspace_id(gateway_customer_id)));

create policy "read ws usage" on public.usage_counters
  for select using (public.is_workspace_member(workspace_id));

create policy "owner reads workspace invitations" on public.workspace_invitations
  for select using (public.is_workspace_owner(workspace_id));

create policy "invitee reads own invitations" on public.workspace_invitations
  for select using (lower(invitee_email) = lower((select auth.email())));

create policy "read ws servers" on public.servers
  for select using (public.is_workspace_member(workspace_id));

create policy "read ws mastra threads" on public.mastra_threads
  for select using (public.is_workspace_member(workspace_id));

create policy "read ws mastra messages" on public.mastra_messages
  for select using (public.is_workspace_member(workspace_id));

create policy "read ws mastra resources" on public.mastra_resources
  for select using (public.is_workspace_member(workspace_id));

create policy "read ws mastra embeddings" on public.mastra_message_embeddings
  for select using (public.is_workspace_member(workspace_id));

create policy "read ws mastra om" on public.mastra_observational_memory
  for select using (public.is_workspace_member(workspace_id));

-- ── service-role-only surfaces (RLS enabled, NO policy, access revoked) ──────
-- generation_logs: written + read only by the service role (generation pipeline).
revoke all on public.generation_logs from anon, authenticated;

-- ox_corpus: shared RAG index; populated by the ops pipeline (service role) and
-- read only through match_ox_corpus (SECURITY DEFINER). No direct table access.
revoke all on public.ox_corpus from anon, authenticated;

-- ── table-level SELECT grants (so RLS reads succeed for `authenticated`) ─────
grant select on public.app_users to authenticated;
grant select on public.workspaces to authenticated;
grant select on public.workspace_members to authenticated;
grant select on public.billing_customers to authenticated;
grant select on public.billing_subscriptions to authenticated;
grant select on public.usage_counters to authenticated;
grant select on public.workspace_invitations to authenticated;
grant select on public.servers to authenticated;
grant select on public.mastra_threads to authenticated;
grant select on public.mastra_messages to authenticated;
grant select on public.mastra_resources to authenticated;
grant select on public.mastra_message_embeddings to authenticated;
grant select on public.mastra_observational_memory to authenticated;

-- ── lock EXECUTE on every app RPC to authenticated + service_role ────────────
-- Postgres grants EXECUTE to PUBLIC on every new function, and anon is a member
-- of PUBLIC — so `revoke ... from anon` alone leaves anon able to call them.
-- Revoke from PUBLIC (which is what actually exposes anon) and re-grant to the
-- two roles that legitimately call these via PostgREST: authenticated (the
-- renderer's Discord JWT) and service_role (the edge functions). The loop targets
-- only OUR functions — pgvector's extension-owned functions (deptype 'e') are
-- skipped, so vector operators keep their default privileges.
do $$
declare fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and not exists (
        select 1 from pg_depend d
        where d.objid = p.oid and d.deptype = 'e'
      )
  loop
    execute format('revoke execute on function %s from public, anon;', fn);
    execute format('grant execute on function %s to authenticated, service_role;', fn);
  end loop;
end $$;
