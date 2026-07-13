-- ── Clean baseline 01: extensions + RAG retrieval ───────────────────────────
-- myRP.build's Supabase schema, repaved into a clean by-concern baseline.
-- Forward-only from here; never edit an applied migration.
--
-- pgvector powers the ox_overextended RAG index. The `vector` extension brings
-- ~118 functions + the vector/halfvec/sparsevec types into `public` automatically
-- (they are extension-owned, so a `--schema public` dump/diff correctly ignores
-- them — we never hand-author them). The `ox_corpus` table is NOT a migration
-- object: @mastra/pg PgVector creates it at ingest time (id / vector_id /
-- embedding vector(1536) / metadata jsonb + an HNSW cosine index). We own only
-- the extension and the retrieval function; `check_function_bodies = off` lets
-- the SQL function be created before ox_corpus exists (resolved at call time).

set check_function_bodies = off;

create extension if not exists vector;

create or replace function public.match_ox_corpus(
  query_embedding vector,
  match_count integer default 8
)
returns table (
  text text,
  source_url text,
  source_type text,
  similarity double precision
)
language sql
stable
as $$
  select
    metadata->>'text' as text,
    metadata->>'source_url' as source_url,
    metadata->>'source_type' as source_type,
    1 - (embedding <=> query_embedding) as similarity
  from public.ox_corpus
  order by embedding <=> query_embedding
  limit match_count;
$$;
