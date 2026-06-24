-- ── Caller's role in a workspace (M3.2 — fivem-studio-lbe) ───────────────────
-- Shared team threads tag every USER message in MAIN with a
-- <turn author_id author_name functional_role> built from the AUTHENTICATED
-- identity (auth.uid()/auth.email()) + the member's workspace_members.role. This
-- RPC resolves that role for the caller from auth.uid() — never from a client
-- arg, so attribution can't be spoofed.
--
-- Returns the role text ('owner' | 'admin' | 'developer'), or NULL when the
-- caller is not a member of the workspace. SECURITY DEFINER + set search_path =
-- public, mirroring is_workspace_member / the teams RPCs. No explicit grants: the
-- public schema's default privileges grant EXECUTE to anon/authenticated.

create or replace function public.my_workspace_role(p_workspace_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select wm.role::text
  from workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = auth.uid()
$$;
