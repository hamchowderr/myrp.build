-- ── Server GitHub remote ─────────────────────────────────────────────────────
-- A server folder can be backed up to a GitHub repo (git, NOT Dolt). The repo
-- URL is SHARED across the workspace so every team member's client points at the
-- same remote — team sharing itself is GitHub-native (collaborator invites),
-- managed by humans, not the app. Only a non-secret https remote URL is stored;
-- the per-user GitHub OAuth token NEVER touches the database (Electron safeStorage
-- only — see src/main/ipc/backup.ts).
--
-- Convention (mirrors servers + mastra_memory): RLS SELECT is via
-- is_workspace_member(); the write goes through a SECURITY DEFINER RPC that
-- re-checks membership and stamps nothing from the client it can't verify.
-- Forward-only (migration-discipline memory).

alter table public.servers
  add column if not exists github_remote_url text;

-- Set (or clear) the shared GitHub remote for a server. Upserts the server row so
-- a remote can be linked before any chat memory has created it. Caller must be a
-- member of the workspace (re-checked via auth.uid(), not the definer). Pass
-- p_github_remote_url = null to disconnect. Idempotent on
-- (workspace_id, client_server_key).
create or replace function public.set_server_github_remote(
  p_workspace_id      uuid,
  p_client_server_key text,
  p_github_remote_url  text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace';
  end if;
  insert into servers (workspace_id, client_server_key, github_remote_url)
    values (p_workspace_id, p_client_server_key, p_github_remote_url)
  on conflict (workspace_id, client_server_key) do update set
    github_remote_url = excluded.github_remote_url,
    updated_at        = now()
  returning id into v_id;
  return v_id;
end; $$;
