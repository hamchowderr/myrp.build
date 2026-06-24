-- ── Servers (fivem-studio-1lc — M3.1) ────────────────────────────────────────
-- A workspace (personal or team) can have MULTIPLE FiveM servers. Each desktop
-- client maps its configured server (settings.serverPath) to a stable
-- client_server_key (a hash of the path); ensure_server upserts the row and
-- returns its id, which scopes the Mastra memory resourceId to
-- ws_<workspace>__srv_<server> so a team's chat memory is shared per-server.
--
-- Convention (mirrors teams + mastra_memory): every row carries workspace_id;
-- RLS is SELECT-only via is_workspace_member(); all writes go through the
-- SECURITY DEFINER ensure_server RPC which re-checks membership. Forward-only.

create table public.servers (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  client_server_key text not null,            -- stable hash of the client's server path
  name              text,                     -- friendly label (optional)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (workspace_id, client_server_key)
);

create index servers_workspace_idx on public.servers (workspace_id);

-- Now that servers exists, point the mastra memory server_id columns at it (the
-- columns are nullable since M2.1). ON DELETE SET NULL preserves chat history if
-- a server row is ever removed.
alter table public.mastra_threads
  add constraint mastra_threads_server_fk
  foreign key (server_id) references public.servers (id) on delete set null;
alter table public.mastra_messages
  add constraint mastra_messages_server_fk
  foreign key (server_id) references public.servers (id) on delete set null;

-- RLS: SELECT-only for the JWT role; writes go through ensure_server below.
alter table public.servers enable row level security;

create policy "read ws servers" on public.servers
  for select using (public.is_workspace_member(workspace_id));

-- Upsert the caller's server for a workspace and return its id. Caller must be a
-- member of the workspace (re-checked here via auth.uid(), not the definer).
-- Idempotent on (workspace_id, client_server_key); supports multiple servers per
-- workspace (each distinct client_server_key is its own row).
create or replace function public.ensure_server(
  p_workspace_id      uuid,
  p_client_server_key text,
  p_name              text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace';
  end if;
  insert into servers (workspace_id, client_server_key, name)
    values (p_workspace_id, p_client_server_key, p_name)
  on conflict (workspace_id, client_server_key) do update set
    name       = coalesce(excluded.name, servers.name),
    updated_at = now()
  returning id into v_id;
  return v_id;
end; $$;
