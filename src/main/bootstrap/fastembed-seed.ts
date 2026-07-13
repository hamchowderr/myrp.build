/**
 * Pre-seed the fastembed bge-small weights into the cache @mastra/fastembed expects.
 *
 * @mastra/fastembed hardcodes its model cache to
 * `~/.cache/mastra/fastembed-models/<model>` and, on the first embedding call,
 * downloads bge-small (~130 MB) from GCS when that dir is absent
 * (`FlagEmbedding.retrieveModel` short-circuits when it already exists). A packaged,
 * offline, or first-run-without-network install would otherwise fail every vector
 * path (ox RAG + own-resource search, see mastra/embedder.ts) until the download
 * finishes — there is no public API to point fastembed at a different location.
 *
 * The installer bundles the weights as an extraResource
 * (`<resources>/fastembed-models/<model>`, populated at build time by
 * build/prefetch-fastembed-model.cjs). At first launch we copy them into the cache
 * dir when missing, so `retrieveModel` finds them and never hits the network.
 * Idempotent and best-effort: any failure just falls back to the runtime download.
 *
 * Dev is unaffected — unpackaged runs download to the cache on first use as before.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import log from "electron-log/main";

/**
 * Cache layout owned by @mastra/fastembed. MUST match its hardcoded path
 * (`os.homedir()/.cache/mastra/fastembed-models`) and the `EmbeddingModel` enum
 * value for the bge-small subdir — embedder.ts pins `fastembed.small`.
 */
const MODEL_DIR_NAME = "fast-bge-small-en-v1.5";
const CACHE_SUBPATH = [".cache", "mastra", "fastembed-models"] as const;

export type SeedOutcome = "seeded" | "skip-exists" | "skip-no-bundle";

/**
 * Copy a bundled model dir into the fastembed cache when it isn't already there.
 * Pure (paths in, no electron) so it's unit-testable.
 */
export function seedModelDir(opts: {
  bundledModelDir: string;
  cacheRoot: string;
  cacheModelDir: string;
}): SeedOutcome {
  if (existsSync(opts.cacheModelDir)) return "skip-exists";
  if (!existsSync(opts.bundledModelDir)) return "skip-no-bundle";
  mkdirSync(opts.cacheRoot, { recursive: true });
  cpSync(opts.bundledModelDir, opts.cacheModelDir, { recursive: true });
  return "seeded";
}

/**
 * Seed the bundled bge-small weights into the fastembed cache at launch.
 * Packaged builds only; never throws.
 */
export function seedFastembedModel(): void {
  if (!app.isPackaged) return; // dev downloads on first use, as before
  try {
    const cacheRoot = join(homedir(), ...CACHE_SUBPATH);
    const outcome = seedModelDir({
      bundledModelDir: join(process.resourcesPath, "fastembed-models", MODEL_DIR_NAME),
      cacheRoot,
      cacheModelDir: join(cacheRoot, MODEL_DIR_NAME),
    });
    if (outcome === "seeded") log.info("[fastembed] seeded bundled bge-small into model cache");
    else if (outcome === "skip-no-bundle")
      log.warn("[fastembed] no bundled model found — embeddings will download on first use");
  } catch (err) {
    log.error("[fastembed] model seed failed (will fall back to download):", err);
  }
}
