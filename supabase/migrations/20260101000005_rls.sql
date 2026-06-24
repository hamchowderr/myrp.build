-- ── Clean baseline 05: RLS policies ──────────────────────────────────────────
-- SELECT-only policies for the anon/JWT role; identity via auth.uid(). All writes
-- go through the SECURITY DEFINER RPCs (baseline 04) or the service role (which
-- bypasses RLS), so there are deliberately no INSERT/UPDATE/DELETE policies —
-- RLS denies those for the anon role by default. generation_logs has no policy
-- (RLS is not enabled on it; service-role only).

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
