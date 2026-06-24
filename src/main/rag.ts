/**
 * ox_overextended RAG retrieval (spec §6).
 *
 * Embeds the user's prompt and queries the SHARED, read-only ox corpus for the
 * most relevant ox API docs / source patterns, returning them as `string[]` in
 * the same shape as the QMD server-context results so they slot into the system
 * prompt identically.
 *
 * Cloud cutover (M3.3 — fivem-studio-r4w): retrieval no longer opens a direct
 * `pg` connection to `RAG_DATABASE_URL` (a DB credential that must never ship in
 * the desktop client). Instead it calls the cloud `match_ox_corpus` RPC through
 * supabase-js, authenticated with the baked anon key + the per-run user JWT (the
 * same `RunSupabaseClient` the cloud memory adapter uses). ox_corpus is a shared
 * knowledge base — no workspace scoping; an authenticated read is sufficient. The
 * vector ingest that POPULATES ox_corpus stays an offline ops job (service role,
 * never ships).
 *
 * Embeddings are produced LOCALLY by fastembed (bge-small-en-v1.5, 384-dim) via
 * the shared {@link EMBEDDER} — no API key, no per-query cost, nothing leaves the
 * machine. The model MUST match the one the ox_corpus index was built with (the
 * fivem-rag-ingestion pipeline) or vector search breaks (fivem-studio-1n47).
 *
 * Fail-safe by design: any misconfiguration or error returns `[]` and logs a
 * warning — generation continues without RAG rather than breaking.
 *
 * Env:
 *   RAG_MATCH_COUNT    Optional, default 8.
 */

import { embed } from "ai";
import log from "electron-log/main";
import { EMBEDDER } from "./mastra/embedder";
import type { RunSupabaseClient } from "./mastra/storage";

const DEFAULT_MATCH_COUNT = 8;

interface MatchRow {
  text: string;
  source_url: string;
  source_type: string;
  similarity: number;
}

/** Embed a single string locally via fastembed (CPU, no key, no network). */
async function embedQuery(prompt: string): Promise<number[] | null> {
  try {
    const { embedding } = await embed({ model: EMBEDDER, value: prompt });
    return Array.isArray(embedding) ? embedding : null;
  } catch (err) {
    log.warn("[rag] embedding error:", err);
    return null;
  }
}

/**
 * Retrieve ox knowledge relevant to `prompt` from the shared cloud corpus via the
 * `match_ox_corpus` RPC. Returns formatted snippets, or `[]` if RAG is
 * unconfigured (no authenticated client) or anything fails.
 *
 * @param prompt  The user's turn — embedded and matched against ox_corpus.
 * @param client  A run Supabase client (anon key + per-run JWT). When absent
 *                (dev-bypass / no sign-in) RAG silently no-ops — there is no DB
 *                fallback by design, so no credential is ever needed at runtime.
 */
export async function queryOxContext(
  prompt: string,
  client: RunSupabaseClient | undefined,
): Promise<string[]> {
  if (!client) {
    // Not configured — silently no-op (RAG is optional, and a missing client
    // means no authenticated cloud read is possible). Embeddings are local now,
    // so no API key is required — only an authenticated Supabase client.
    return [];
  }

  const matchCount = Number.parseInt(process.env.RAG_MATCH_COUNT ?? "", 10) || DEFAULT_MATCH_COUNT;

  const embedding = await embedQuery(prompt);
  if (!embedding) return [];

  try {
    // The RPC expects a pgvector literal: supabase-js sends the JSON array string,
    // which Postgres coerces to `vector` via the `query_embedding vector` arg.
    const vectorLiteral = `[${embedding.join(",")}]`;
    const { data, error } = await client.rpc("match_ox_corpus", {
      query_embedding: vectorLiteral,
      match_count: matchCount,
    });
    if (error) {
      log.warn("[rag] match_ox_corpus RPC failed, continuing without ox context:", error.message);
      return [];
    }

    const rows = (data ?? []) as MatchRow[];
    if (rows.length > 0) {
      log.info(`[rag] queryOxContext returned ${rows.length} ox snippets`);
    }

    return rows.map(
      (r) =>
        `[${r.source_type}] ${r.source_url} (similarity: ${r.similarity.toFixed(3)})\n${r.text}`,
    );
  } catch (err) {
    log.warn("[rag] query failed, continuing without ox context:", err);
    return [];
  }
}
