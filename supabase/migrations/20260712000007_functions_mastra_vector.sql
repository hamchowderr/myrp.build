-- ── Consolidated baseline 04d: Mastra vector/OM/search RPCs ───────────────────
set check_function_bodies = off;

-- ── Mastra semantic-recall vector writes / match ─────────────────────────────

-- Bulk upsert embeddings. p_rows is a JSON array of objects, each:
--   { id, message_id?, thread_id?, resource_id?, content?, metadata?, embedding }
-- where embedding is a JSON array of numbers (cast to vector). workspace_id is
-- the caller's validated scope; membership is re-checked.
create or replace function public.mastra_upsert_embeddings(p_workspace_id uuid, p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_row jsonb;
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return; end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    insert into mastra_message_embeddings (
      id, message_id, thread_id, resource_id, workspace_id, embedding, content, metadata, created_at
    ) values (
      v_row ->> 'id',
      v_row ->> 'message_id',
      v_row ->> 'thread_id',
      v_row ->> 'resource_id',
      p_workspace_id,
      (v_row ->> 'embedding')::vector,
      v_row ->> 'content',
      v_row -> 'metadata',
      now()
    )
    on conflict (id) do update set
      embedding   = excluded.embedding,
      content     = excluded.content,
      metadata    = excluded.metadata,
      thread_id   = excluded.thread_id,
      resource_id = excluded.resource_id;
  end loop;
end; $$;

-- Similarity match scoped to a workspace, optionally filtered by thread or
-- resource (mirrors Mastra's semantic-recall filter { thread_id } | { resource_id }).
create or replace function public.mastra_match_embeddings(
  p_workspace_id  uuid,
  query_embedding vector,
  match_count     integer default 5,
  p_thread_id     text default null,
  p_resource_id   text default null
)
returns table (
  id          text,
  message_id  text,
  thread_id   text,
  resource_id text,
  content     text,
  metadata    jsonb,
  similarity  double precision
)
language sql stable security definer set search_path = public as $$
  select e.id, e.message_id, e.thread_id, e.resource_id, e.content, e.metadata,
         1 - (e.embedding <=> query_embedding) as similarity
  from mastra_message_embeddings e
  where public.is_workspace_member(p_workspace_id)
    and e.workspace_id = p_workspace_id
    and (p_thread_id is null or e.thread_id = p_thread_id)
    and (p_resource_id is null or e.resource_id = p_resource_id)
  order by e.embedding <=> query_embedding
  limit match_count;
$$;

-- Delete embeddings by id (e.g. when their messages are deleted). Membership
-- re-checked per row.
create or replace function public.mastra_delete_embeddings(p_ids text[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_ids is null or array_length(p_ids, 1) is null then return; end if;
  delete from mastra_message_embeddings e
  where e.id = any(p_ids) and public.is_workspace_member(e.workspace_id);
end; $$;

-- ── Mastra observational memory writes ───────────────────────────────────────

-- Insert or replace a full OM record (used by initialize / insert / new generation).
create or replace function public.mastra_om_upsert(
  p_workspace_id     uuid,
  p_id               text,
  p_lookup_key       text,
  p_generation_count integer,
  p_record           jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace';
  end if;
  insert into mastra_observational_memory (id, lookup_key, workspace_id, generation_count, record, created_at, updated_at)
    values (p_id, p_lookup_key, p_workspace_id, coalesce(p_generation_count, 0), p_record, now(), now())
  on conflict (id) do update set
    record           = excluded.record,
    generation_count = excluded.generation_count,
    lookup_key       = excluded.lookup_key,
    updated_at       = now()
  where public.is_workspace_member(mastra_observational_memory.workspace_id);
end; $$;

-- Shallow-merge a patch into an existing record (record || p_patch). The adapter
-- computes any derived values (token totals, swaps, deep-merged config) in JS and
-- sends the resolved fields, so a shallow merge is sufficient + faithful.
create or replace function public.mastra_om_patch(p_id text, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_ws uuid;
begin
  select workspace_id into v_ws from mastra_observational_memory where id = p_id;
  if v_ws is null then raise exception 'observational memory record not found: %', p_id; end if;
  if not public.is_workspace_member(v_ws) then raise exception 'not a member of this workspace'; end if;
  update mastra_observational_memory set
    record           = record || p_patch,
    generation_count = coalesce((p_patch ->> 'generationCount')::integer, generation_count),
    updated_at       = now()
  where id = p_id;
end; $$;

-- Delete all generations for a lookup key (clearObservationalMemory).
create or replace function public.mastra_om_clear(p_lookup_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from mastra_observational_memory e
  where e.lookup_key = p_lookup_key and public.is_workspace_member(e.workspace_id);
end; $$;

-- ── Mastra chat search ───────────────────────────────────────────────────────
-- A single SECURITY DEFINER read RPC that searches a resource's conversations by
-- TITLE and message CONTENT and returns one row per matching thread with a
-- snippet around the body match. Done in one definer function because
-- mastra_messages.content is jsonb (PostgREST can't ILIKE/cast it in a filter)
-- and the tables are RLS SELECT-only — this keeps the membership re-check
-- server-side (auth.uid(), not the definer).
create or replace function public.mastra_search_messages(
  p_resource_id text,
  p_query       text,
  p_limit       int default 30
)
returns table (
  thread_id   text,
  title       text,
  snippet     text,
  updated_at  timestamptz,
  archived_at text
)
language plpgsql security definer set search_path = public as $$
declare
  v_q    text;
  v_like text;
begin
  v_q := btrim(coalesce(p_query, ''));
  if length(v_q) < 2 then
    return;  -- too short to search — empty result
  end if;

  -- Escape LIKE wildcards so a literal % or _ in the query is matched literally.
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
  with
  -- Flatten each message's content jsonb to plaintext: prefer the top-level
  -- `content` string, else concatenate its text parts (MastraMessageContentV2).
  bodies as (
    select
      m.thread_id,
      m.created_at,
      -- Strip the spoof-proof <turn …> attribution tag prepended to user
      -- messages so it neither matches the query nor pollutes snippets.
      btrim(regexp_replace(
        coalesce(
          nullif(m.content ->> 'content', ''),
          case when jsonb_typeof(m.content -> 'parts') = 'array' then (
            select string_agg(pt ->> 'text', ' ')
            from jsonb_array_elements(m.content -> 'parts') pt
            where pt ->> 'type' = 'text'
          ) end,
          ''
        ),
        '^\s*<turn[^>]*>\s*', ''
      )) as body
    from mastra_messages m
    join mastra_threads t on t.id = m.thread_id
    where t.resource_id = p_resource_id
      and public.is_workspace_member(m.workspace_id)
  ),
  -- Most-recent matching message per thread (the snippet source).
  body_hits as (
    select distinct on (b.thread_id)
      b.thread_id,
      b.body,
      b.created_at
    from bodies b
    where b.body ilike v_like escape '\'
    order by b.thread_id, b.created_at desc
  ),
  -- Threads whose generated title matches (sidebar shows the title, so search
  -- must cover it too — even with no body hit).
  title_hits as (
    select th.id as thread_id
    from mastra_threads th
    where th.resource_id = p_resource_id
      and public.is_workspace_member(th.workspace_id)
      and coalesce(th.title, '') ilike v_like escape '\'
  ),
  -- Aliases are mandatory here: the bare column name `thread_id` would be
  -- ambiguous against the function's RETURNS TABLE out-parameter of the same
  -- name (Postgres error 42702).
  matched as (
    select b.thread_id from body_hits b
    union
    select t.thread_id from title_hits t
  )
  select
    th.id,
    th.title,
    -- Snippet: ~40 chars before the match, ~100 after; ellipsised. Falls back to
    -- the head of the latest message (title-only hits) or null.
    case
      when bh.body is null then left(nullif(bh2.body, ''), 120)
      when position(lower(v_q) in lower(bh.body)) > 0 then
        (case when position(lower(v_q) in lower(bh.body)) > 41 then '…' else '' end)
        || btrim(substr(
             bh.body,
             greatest(1, position(lower(v_q) in lower(bh.body)) - 40),
             length(v_q) + 100
           ))
        || (case
              when greatest(1, position(lower(v_q) in lower(bh.body)) - 40) + length(v_q) + 100
                   <= length(bh.body) then '…' else '' end)
      else left(bh.body, 120)
    end as snippet,
    th.updated_at,
    th.metadata ->> 'archivedAt' as archived_at
  from matched mt
  join mastra_threads th on th.id = mt.thread_id
  left join body_hits bh on bh.thread_id = mt.thread_id
  -- Fallback snippet source for title-only hits: the thread's latest message.
  left join lateral (
    select b2.body
    from bodies b2
    where b2.thread_id = mt.thread_id
    order by b2.created_at desc
    limit 1
  ) bh2 on true
  order by th.updated_at desc
  limit greatest(1, coalesce(p_limit, 30));
end; $$;
