-- ── Mastra semantic recall vector store ─────────────────────────────
-- Backs a custom SupabaseVector (extends @mastra/core MastraVector) so Mastra
-- Memory's semantic recall works on cloud Supabase pgvector — same secure model
-- as match_ox_corpus: RLS SELECT-only table, all writes + the similarity match
-- through SECURITY DEFINER RPCs that re-check is_workspace_member.
--
-- CAPABILITY ONLY: this ships the storage so semantic recall CAN be turned on.
-- It is NOT enabled — chat.ts keeps semanticRecall:false until the owner accepts
-- the per-message embedding API cost. Dimension is fixed to 1536
-- (text-embedding-3-small, matching rag.ts / ox_corpus).

create table public.mastra_message_embeddings (
  id           text primary key,           -- vector id (Mastra-generated)
  message_id   text,                       -- source message id (metadata.message_id)
  thread_id    text,                       -- semantic-recall filter scope (thread)
  resource_id  text,                       -- semantic-recall filter scope (resource)
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  embedding    vector(1536) not null,
  content      text,
  metadata     jsonb,
  created_at   timestamptz not null default now()
);

create index mastra_message_embeddings_workspace_idx on public.mastra_message_embeddings (workspace_id);
create index mastra_message_embeddings_thread_idx    on public.mastra_message_embeddings (thread_id);
create index mastra_message_embeddings_resource_idx  on public.mastra_message_embeddings (resource_id);
create index mastra_message_embeddings_hnsw          on public.mastra_message_embeddings using hnsw (embedding vector_cosine_ops);

alter table public.mastra_message_embeddings enable row level security;

create policy "read ws mastra embeddings" on public.mastra_message_embeddings
  for select using (public.is_workspace_member(workspace_id));

-- ── vector writes (SECURITY DEFINER) ─────────────────────────────────────────

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
