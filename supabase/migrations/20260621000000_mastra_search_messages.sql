-- ── Mastra chat search (Foreman parity) ───────────────────────────
-- A single SECURITY DEFINER read RPC that searches a resource's conversations by
-- TITLE and message CONTENT and returns one row per matching thread with a
-- snippet around the body match. Foreman does this client-side across 4 queries;
-- we can't, because mastra_messages.content is jsonb (PostgREST can't ILIKE a
-- jsonb column or cast in a filter) and the tables are RLS SELECT-only. Doing it
-- in one definer function also keeps the membership re-check server-side.
--
-- Authorization mirrors the other mastra_* RPCs: the membership check uses
-- public.is_workspace_member() against the REAL caller (auth.uid()), not the
-- definer, so a non-member can't read another tenant's threads even though the
-- function runs as definer.

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
