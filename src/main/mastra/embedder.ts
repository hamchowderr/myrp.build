/**
 * Local embedding model — one source of truth for every pgvector path in the app.
 *
 * fastembed bge-small-en-v1.5 runs entirely on CPU via onnxruntime (no API key,
 * no per-query cost, nothing leaves the machine). It replaced the paid OpenAI
 * text-embedding-3-small (1536-dim) for BOTH the ox RAG corpus and the workspace
 * own-resource search (fivem-studio-1n47).
 *
 * CRITICAL: this MUST stay identical to the embedder the indexes were BUILT with
 * (the fivem-rag-ingestion pipeline embeds ox_corpus with `fastembed.small`). A
 * model/dimension mismatch between write-time and query-time silently breaks
 * vector search. If the retrieval-quality gate ever forces a bigger model, change
 * it HERE (and re-ingest at the new dimension) — every consumer imports from here.
 *
 * Packaging note (fivem-studio follow-up): onnxruntime-node is a native addon and
 * the bge-small weights download on first use — both need the asarUnpack / model
 * bundling treatment before this ships in a packaged Electron build.
 */

import { fastembed } from "@mastra/fastembed";

/** AI-SDK embedding model used by every vector path (`embed`/`embedMany`, Memory). */
export const EMBEDDER = fastembed.small;

/** Output dimension of {@link EMBEDDER}. Bump alongside the model if it ever changes. */
export const EMBEDDING_DIMENSION = 384;
