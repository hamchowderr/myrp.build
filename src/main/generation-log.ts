/**
 * Generation logging + feedback capture (fivem-studio-zhk.9).
 *
 * Records every resource generation to the local Postgres `generation_logs`
 * table and lets the renderer attach a thumbs up/down rating afterward. This is
 * the implicit/explicit quality signal that seeds the OWNER's fine-tune dataset
 * (zhk.10) — an ops/dev concern, NOT a per-user prod feature.
 *
 * DEV-ONLY (M3.4 — fivem-studio-dhq): this is the last remaining runtime
 * RAG_DATABASE_URL consumer. It writes via a direct `pg` connection (a DB
 * credential that must NEVER ship), so it is hard-gated to dev (`__DEV_BYPASS__`)
 * in addition to the env gate. In a packaged build dotenv never loads
 * RAG_DATABASE_URL and `__DEV_BYPASS__` compiles to `false`, so connect() returns
 * null and logging is a silent no-op — the user's generation is unaffected.
 *
 * Fail-safe by design: every function swallows errors and logs a warning —
 * logging must NEVER break or delay a generation. If the DB is unreachable the
 * generation completes normally; we just lose that one log row.
 */

import log from "electron-log/main";
import { Client } from "pg";

export interface GenerationLogRecord {
  prompt: string;
  model?: string;
  ragUsed: boolean;
  ragChunkCount: number;
  resourceName?: string;
  outputFiles?: string[];
  staticPass?: boolean;
  repairLoops?: number;
  threadId?: string;
}

export type Rating = "up" | "down";

/** Open a short-lived client to the generation-log DB, or null if unconfigured.
 *  Dev/ops-only: never opens a direct DB connection from a packaged build (M3.4 —
 *  no DB credential ships; RAG_DATABASE_URL is dev-only). */
async function connect(): Promise<Client | null> {
  if (!__DEV_BYPASS__) return null;
  const url = process.env.RAG_DATABASE_URL;
  if (!url) return null;
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/**
 * Insert a generation log row. Returns the new row id (for the renderer to later
 * attach a rating), or null if logging was skipped/failed.
 */
export async function logGeneration(record: GenerationLogRecord): Promise<string | null> {
  let client: Client | null = null;
  try {
    client = await connect();
    if (!client) return null;
    const res = await client.query<{ id: string }>(
      `insert into public.generation_logs
         (prompt, model, rag_used, rag_chunk_count, resource_name,
          output_files, static_pass, repair_loops, thread_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        record.prompt,
        record.model ?? null,
        record.ragUsed,
        record.ragChunkCount,
        record.resourceName ?? null,
        record.outputFiles ? JSON.stringify(record.outputFiles) : null,
        record.staticPass ?? null,
        record.repairLoops ?? null,
        record.threadId ?? null,
      ],
    );
    return res.rows[0]?.id ?? null;
  } catch (err) {
    log.warn("[generation-log] insert failed (continuing):", err);
    return null;
  } finally {
    await client?.end().catch(() => {});
  }
}

/** Attach/update a thumbs up/down rating on a logged generation. */
export async function rateGeneration(id: string, rating: Rating): Promise<boolean> {
  let client: Client | null = null;
  try {
    client = await connect();
    if (!client) return false;
    await client.query(`update public.generation_logs set user_rating = $2 where id = $1`, [
      id,
      rating,
    ]);
    return true;
  } catch (err) {
    log.warn("[generation-log] rate failed:", err);
    return false;
  } finally {
    await client?.end().catch(() => {});
  }
}
