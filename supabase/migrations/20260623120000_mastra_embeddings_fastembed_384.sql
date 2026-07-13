-- ── Semantic-recall embeddings → fastembed 384-dim ───────────────────────────
-- Semantic recall switched from OpenAI text-embedding-3-small (1536) to local
-- fastembed bge-small-en-v1.5 (384). The embedding column must match the new
-- model's dimension, and a single HNSW index cannot hold mixed dimensions.
--
-- Stored embeddings are DERIVED from chat messages (not source data), so clearing
-- them is safe — they re-embed as conversations continue. In prod this table was
-- never populated (semantic recall shipped disabled), so the truncate is a no-op
-- there; locally it drops the stale 1536-dim dev vectors. Forward-only; never edit
-- the original create migration (20260609010000).

drop index if exists public.mastra_message_embeddings_hnsw;

truncate table public.mastra_message_embeddings;

alter table public.mastra_message_embeddings
  alter column embedding type vector(384);

create index mastra_message_embeddings_hnsw
  on public.mastra_message_embeddings using hnsw (embedding vector_cosine_ops);
