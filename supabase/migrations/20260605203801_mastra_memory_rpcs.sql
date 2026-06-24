-- ── Mastra cloud chat memory write RPCs (M2.2 — fivem-studio-490) ────────────
-- All SECURITY DEFINER, set search_path = public. The mastra_threads /
-- mastra_messages tables are RLS SELECT-only (M2.1), so EVERY write happens here
-- and authorization is enforced INSIDE each function:
--   • re-check public.is_workspace_member(workspace_id) (the real caller via
--     auth.uid(), not the definer),
--   • identity (author_id/author_email) is stamped from auth.uid()/auth.email()
--     for user-role messages — any client-supplied author is IGNORED,
--   • resource_id/server_id/workspace_id come from the validated thread, not from
--     forged per-message args.
-- No explicit grants: the public schema's default privileges grant EXECUTE to
-- anon/authenticated/service_role.

-- ── thread writes ────────────────────────────────────────────────────────────

-- Upsert a thread. Caller must be a member of p_workspace_id.
create or replace function public.mastra_save_thread(
  p_thread_id   text,
  p_workspace_id uuid,
  p_resource_id text,
  p_server_id   uuid default null,
  p_title       text default null,
  p_metadata    jsonb default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace';
  end if;
  insert into mastra_threads (id, workspace_id, server_id, resource_id, title, metadata, created_at, updated_at)
    values (p_thread_id, p_workspace_id, p_server_id, p_resource_id, p_title, p_metadata, now(), now())
  on conflict (id) do update set
    -- workspace_id is immutable on conflict (a thread can't change tenants); only
    -- update mutable fields. Re-check membership of the EXISTING owner too.
    resource_id = excluded.resource_id,
    server_id   = excluded.server_id,
    title       = excluded.title,
    metadata    = excluded.metadata,
    updated_at  = now()
  where public.is_workspace_member(mastra_threads.workspace_id);
end; $$;

-- Update a thread's title/metadata (metadata is merged). Caller must be a member
-- of the thread's workspace. Returns nothing; the adapter re-reads via RLS.
create or replace function public.mastra_update_thread(
  p_id       text,
  p_title    text,
  p_metadata jsonb default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_meta jsonb;
begin
  select workspace_id, metadata into v_ws, v_meta from mastra_threads where id = p_id;
  if v_ws is null then raise exception 'thread % not found', p_id; end if;
  if not public.is_workspace_member(v_ws) then raise exception 'not a member of this workspace'; end if;
  update mastra_threads set
    title      = coalesce(p_title, title),
    metadata   = coalesce(v_meta, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb),
    updated_at = now()
  where id = p_id;
end; $$;

-- Delete a thread (messages cascade). Caller must be a member of its workspace.
create or replace function public.mastra_delete_thread(p_thread_id text)
returns void language plpgsql security definer set search_path = public as $$
declare v_ws uuid;
begin
  select workspace_id into v_ws from mastra_threads where id = p_thread_id;
  if v_ws is null then return; end if;  -- already gone — idempotent
  if not public.is_workspace_member(v_ws) then raise exception 'not a member of this workspace'; end if;
  delete from mastra_threads where id = p_thread_id;
end; $$;

-- ── message writes ───────────────────────────────────────────────────────────

-- Bulk upsert messages. p_messages is a JSON array of objects, each:
--   { id, threadId, role, type?, content (jsonb), resourceId? }
-- For every message:
--   • the parent thread is resolved and the caller's membership of the thread's
--     workspace is re-checked,
--   • workspace_id/server_id are taken from the thread (NOT from client args),
--   • for role='user', author_id := auth.uid() and author_email := auth.email()
--     (any client-supplied author is dropped); other roles get null author,
--   • the thread's updated_at is bumped.
create or replace function public.mastra_save_messages(p_messages jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid  := auth.uid();
  v_email text  := auth.email();
  v_msg   jsonb;
  v_thread_id text;
  v_ws    uuid;
  v_srv   uuid;
  v_role  text;
  v_threads text[] := array[]::text[];
begin
  if p_messages is null or jsonb_typeof(p_messages) <> 'array' then return; end if;

  for v_msg in select * from jsonb_array_elements(p_messages) loop
    v_thread_id := v_msg ->> 'threadId';
    if v_thread_id is null then raise exception 'message missing threadId'; end if;

    select workspace_id, server_id into v_ws, v_srv from mastra_threads where id = v_thread_id;
    if v_ws is null then raise exception 'thread % not found', v_thread_id; end if;
    if not public.is_workspace_member(v_ws) then raise exception 'not a member of this workspace'; end if;

    v_role := v_msg ->> 'role';

    insert into mastra_messages (
      id, thread_id, workspace_id, server_id, resource_id, role, type, content, author_id, author_email, created_at
    ) values (
      v_msg ->> 'id',
      v_thread_id,
      v_ws,
      v_srv,
      v_msg ->> 'resourceId',
      v_role,
      coalesce(v_msg ->> 'type', 'v2'),
      coalesce(v_msg -> 'content', '{}'::jsonb),
      case when v_role = 'user' then v_uid else null end,
      case when v_role = 'user' then v_email else null end,
      coalesce((v_msg ->> 'createdAt')::timestamptz, now())
    )
    on conflict (id) do update set
      thread_id   = excluded.thread_id,
      workspace_id = excluded.workspace_id,
      server_id   = excluded.server_id,
      resource_id = excluded.resource_id,
      role        = excluded.role,
      type        = excluded.type,
      content     = excluded.content
      -- author_* are intentionally NOT updated on conflict: the first writer's
      -- authenticated identity is authoritative; a later upsert can't re-stamp it.
    ;

    v_threads := array_append(v_threads, v_thread_id);
  end loop;

  if array_length(v_threads, 1) is not null then
    update mastra_threads set updated_at = now() where id = any(v_threads);
  end if;
end; $$;

-- Partial-update messages. p_messages is a JSON array of objects, each with `id`
-- and any of: content (merged into existing, with content.metadata deep-merged),
-- role, type. Membership re-checked per message via its parent thread.
create or replace function public.mastra_update_messages(p_messages jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_msg jsonb;
  v_id  text;
  v_ws  uuid;
  v_existing jsonb;
  v_new_content jsonb;
  v_threads text[] := array[]::text[];
  v_thread_id text;
begin
  if p_messages is null or jsonb_typeof(p_messages) <> 'array' then return; end if;

  for v_msg in select * from jsonb_array_elements(p_messages) loop
    v_id := v_msg ->> 'id';
    if v_id is null then continue; end if;

    select m.workspace_id, m.content, m.thread_id
      into v_ws, v_existing, v_thread_id
      from mastra_messages m where m.id = v_id;
    if v_ws is null then continue; end if;  -- unknown message — skip (pg ref returns [])
    if not public.is_workspace_member(v_ws) then raise exception 'not a member of this workspace'; end if;

    -- Merge content: shallow-merge the incoming content over existing, with a
    -- deep-merge of the nested metadata object (mirrors @mastra/pg updateMessages).
    if v_msg ? 'content' then
      v_new_content := coalesce(v_existing, '{}'::jsonb) || coalesce(v_msg -> 'content', '{}'::jsonb);
      if (v_existing ? 'metadata') and ((v_msg -> 'content') ? 'metadata') then
        v_new_content := jsonb_set(
          v_new_content,
          '{metadata}',
          coalesce(v_existing -> 'metadata', '{}'::jsonb) || coalesce((v_msg -> 'content') -> 'metadata', '{}'::jsonb)
        );
      end if;
    else
      v_new_content := v_existing;
    end if;

    update mastra_messages set
      content = v_new_content,
      role    = coalesce(v_msg ->> 'role', role),
      type    = coalesce(v_msg ->> 'type', type)
    where id = v_id;

    v_threads := array_append(v_threads, v_thread_id);
  end loop;

  if array_length(v_threads, 1) is not null then
    update mastra_threads set updated_at = now() where id = any(v_threads);
  end if;
end; $$;
