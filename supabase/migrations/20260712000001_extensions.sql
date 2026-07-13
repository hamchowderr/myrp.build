-- ── Consolidated baseline 01: extensions ─────────────────────────────────────
-- Fresh, consolidated Supabase baseline for myRP.build — declares the FINAL
-- schema directly (no fix-on-fix chain). Forward-only from here; never edit an
-- applied migration.
--
-- pgvector powers the ox_overextended RAG index (public.ox_corpus) and Mastra
-- semantic-recall embeddings. The `vector` extension brings the vector /
-- halfvec / sparsevec types + operators into `public` automatically; they are
-- extension-owned, so a `--schema public` dump/diff correctly ignores them.

create extension if not exists vector;
