#!/usr/bin/env node
// seed-ox-corpus — populate local/self-host Supabase `ox_corpus` so RAG works
// offline (myrp.build ic8).
//
// The shipped snapshot (supabase/ox_corpus.jsonl.gz) holds the ox/FiveM corpus
// WITH precomputed fastembed embeddings (bge-small, 384-dim — the same model the
// app queries with). This loader just decompresses and upserts it, so a from-source
// / self-host install gets real RAG in SECONDS with no embedding step. seed.sql
// can't do this (it's pure SQL and the file is gzipped), so it's a separate step
// you run AFTER `supabase db reset` (which creates the ox_corpus table + pgvector):
//
//   supabase db reset          # applies migrations + seed.sql (dev user)
//   npm run db:seed-corpus     # loads ~15.7k embedded ox chunks (seconds)
//
// Idempotent: upserts on vector_id, so re-running refreshes in place.
//
// Target DB: SEED_DATABASE_URL, else local Supabase (127.0.0.1:55322).
// Exit codes: 0 = seeded · 1 = failed · 2 = precondition missing.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import pg from "pg";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = join(repoRoot, "supabase", "ox_corpus.jsonl.gz");
const DB_URL =
  process.env.SEED_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:55322/postgres";
const BATCH = 1000; // rows per multi-row upsert

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}

/** Parse the gzipped NDJSON snapshot into {vector_id, embedding, metadata} records. */
function loadRows() {
  if (!existsSync(SNAPSHOT)) {
    fail(2, `✗ Snapshot missing: ${SNAPSHOT}\n  It ships with the repo — check your checkout.`);
  }
  const text = gunzipSync(readFileSync(SNAPSHOT)).toString("utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

/** Upsert one batch into ox_corpus in a single multi-row statement. */
async function upsertBatch(client, rows) {
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const base = i * 3;
    values.push(`($${base + 1}, $${base + 2}::vector, $${base + 3}::jsonb)`);
    // embedding ships as a pgvector literal string ("[f,f,...]"); metadata as an object.
    params.push(r.vector_id, r.embedding, JSON.stringify(r.metadata));
  });
  await client.query(
    `INSERT INTO public.ox_corpus (vector_id, embedding, metadata)
     VALUES ${values.join(", ")}
     ON CONFLICT (vector_id) DO UPDATE
       SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata`,
    params,
  );
}

async function main() {
  const rows = loadRows();
  console.log(`▶ ${rows.length} rows from snapshot → ${DB_URL.replace(/:[^:@/]*@/, ":****@")}`);

  const client = new pg.Client({ connectionString: DB_URL });
  try {
    await client.connect();
  } catch (err) {
    fail(
      2,
      `✗ Could not connect to Postgres (${err.message}).\n  Is local Supabase running? (supabase start)`,
    );
  }

  try {
    await client.query("SELECT 1 FROM public.ox_corpus LIMIT 1").catch(() => {
      fail(2, "✗ public.ox_corpus not found — run `supabase db reset` first (applies migrations).");
    });

    let done = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      await upsertBatch(client, rows.slice(i, i + BATCH));
      done += Math.min(BATCH, rows.length - i);
      process.stdout.write(`\r  upserted ${done}/${rows.length}`);
    }
    process.stdout.write("\n");

    const { rows: n } = await client.query("SELECT count(*)::int AS n FROM public.ox_corpus");
    console.log(`✓ ox_corpus now holds ${n[0].n} rows. Local RAG is live.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("\n✗ seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
