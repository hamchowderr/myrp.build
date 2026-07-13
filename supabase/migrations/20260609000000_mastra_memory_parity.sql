-- ── Mastra memory parity: deleteMessages + resource working memory ─
-- Brings the custom SupabaseMemoryStorage adapter to @mastra/pg MemoryPG parity:
--   • message-level delete   (Memory.deleteMessages → storage.deleteMessages)
--   • resource working memory (getResourceById / saveResource / updateResource)
-- Same security model as the M2.2 memory RPCs: any new table is RLS SELECT-only
-- and EVERY write goes through a SECURITY DEFINER function that re-checks
-- public.is_workspace_member() for the REAL caller (auth.uid()), never the definer.

-- ── resources table (resource-scoped working memory) ─────────────────────────
-- One row per Mastra resourceId (= ws_<ws>__srv_<srv>). working_memory is the
-- persisted WM markdown; workspace_id scopes RLS + the workspace index.
create table public.mastra_resources (
  id             text primary key,           -- Mastra resourceId (memory owner scope)
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  working_memory text,
  metadata       jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index mastra_resources_workspace_idx on public.mastra_resources (workspace_id);

-- RLS: SELECT-only for the anon/JWT role; writes via the SECURITY DEFINER RPCs.
alter table public.mastra_resources enable row level security;

create policy "read ws mastra resources" on public.mastra_resources
  for select using (public.is_workspace_member(workspace_id));

-- ── message delete RPC ───────────────────────────────────────────────────────
-- Delete messages by id. Mirrors @mastra/pg MemoryPG.deleteMessages: authorize
-- against every target message's workspace, delete, then bump the affected
-- threads' updated_at. Idempotent (unknown ids are simply not found).
create or replace function public.mastra_delete_messages(p_message_ids text[])
returns void language plpgsql security definer set search_path = public as $$
declare v_threads text[];
begin
  if p_message_ids is null or array_length(p_message_ids, 1) is null then return; end if;

  -- Reject if ANY target message belongs to a workspace the caller isn't in.
  if exists (
    select 1 from mastra_messages
    where id = any(p_message_ids) and not public.is_workspace_member(workspace_id)
  ) then
    raise exception 'not a member of this workspace';
  end if;

  select array_agg(distinct thread_id) into v_threads
    from mastra_messages where id = any(p_message_ids);

  delete from mastra_messages where id = any(p_message_ids);

  if v_threads is not null then
    update mastra_threads set updated_at = now() where id = any(v_threads);
  end if;
end; $$;

-- ── resource writes ──────────────────────────────────────────────────────────
-- Upsert a resource. workspace_id comes from the caller's validated scope (the
-- adapter passes ctx.workspaceId); membership is re-checked.
create or replace function public.mastra_save_resource(
  p_id             text,
  p_workspace_id   uuid,
  p_working_memory text default null,
  p_metadata       jsonb default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace';
  end if;
  insert into mastra_resources (id, workspace_id, working_memory, metadata, created_at, updated_at)
    values (p_id, p_workspace_id, p_working_memory, p_metadata, now(), now())
  on conflict (id) do update set
    -- workspace_id is immutable on conflict (a resource can't change tenants).
    working_memory = excluded.working_memory,
    metadata       = excluded.metadata,
    updated_at     = now()
  where public.is_workspace_member(mastra_resources.workspace_id);
end; $$;

-- Partial-update a resource's working_memory/metadata (metadata merged).
-- Membership re-checked against the existing row's workspace.
create or replace function public.mastra_update_resource(
  p_id             text,
  p_working_memory text default null,
  p_metadata       jsonb default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_meta jsonb;
begin
  select workspace_id, metadata into v_ws, v_meta from mastra_resources where id = p_id;
  if v_ws is null then raise exception 'resource % not found', p_id; end if;
  if not public.is_workspace_member(v_ws) then raise exception 'not a member of this workspace'; end if;
  update mastra_resources set
    working_memory = coalesce(p_working_memory, working_memory),
    metadata       = coalesce(v_meta, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
    updated_at     = now()
  where id = p_id;
end; $$;
