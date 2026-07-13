-- ── RAG read RPC hardening ───────────────────────────────────────────────────
-- The desktop client cuts the RAG read path off the direct RAG_DATABASE_URL
-- pgvector connection (a DB credential that must NEVER ship) onto this RPC,
-- called via supabase-js with the baked anon key + the per-run user JWT.
--
-- ox_corpus is a SHARED, read-only knowledge base (ox/FiveM docs) — there is NO
-- workspace scoping; any AUTHENTICATED user may read it. The table itself is NOT
-- a migration object: @mastra/pg PgVector creates it at offline ingest time
-- (service role, never ships) without RLS or role grants, so a SECURITY INVOKER
-- function would return 0 rows to anon/authenticated once the table exists.
--
-- Forward-only change: redefine match_ox_corpus as SECURITY DEFINER so the read
-- reliably succeeds for any authenticated JWT regardless of ox_corpus's future
-- RLS/grant state, while still REQUIRING authentication (auth.uid() not null —
-- the baked anon key alone, with no user JWT, cannot read the corpus). Signature
-- and return shape are unchanged, so src/types/database.ts needs no regen.
--
-- Offline ingest job (documented, never ships): the fivem-rag-ingestion repo
-- embeds the ox/FiveM corpus and writes public.ox_corpus via @mastra/pg PgVector
-- using the SERVICE ROLE key. That key and the direct DB connection string stay
-- ops-only and are never present in the Electron bundle.

set check_function_bodies = off;

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
security definer
set search_path = public
as $$
  select
    metadata->>'text' as text,
    metadata->>'source_url' as source_url,
    metadata->>'source_type' as source_type,
    1 - (embedding <=> query_embedding) as similarity
  from public.ox_corpus
  -- Require an authenticated caller: the shared corpus is readable by any signed-in
  -- user, but never by an unauthenticated request bearing only the anon key.
  where auth.uid() is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
