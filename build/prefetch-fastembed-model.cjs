/**
 * Build-time prefetch of the fastembed bge-small weights.
 *
 * Runs as electron-builder's `beforePack` hook. Downloads bge-small into
 * build/fastembed-models/<model> so the `extraResources` entry can bundle it into
 * the installer, and the app's first-launch seed (src/main/bootstrap/fastembed-seed.ts)
 * can copy it into ~/.cache/mastra/fastembed-models — no network needed at runtime.
 *
 * Uses @mastra/fastembed's own retrieveModel (public API) so the on-disk layout is
 * exactly what the runtime expects. Idempotent: skips the download if already present.
 */
const path = require("node:path");
const fs = require("node:fs");

const OUT_DIR = path.join(__dirname, "fastembed-models");
const MODEL_DIR = "fast-bge-small-en-v1.5";

module.exports = async function prefetchFastembedModel() {
  const target = path.join(OUT_DIR, MODEL_DIR);
  if (fs.existsSync(target)) {
    console.log(`[prefetch-fastembed] model already present at ${target} — skipping download`);
    return;
  }
  // Deferred require — only needed when a package is actually being built.
  const { FlagEmbedding, EmbeddingModel } = require("@mastra/fastembed");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[prefetch-fastembed] downloading ${MODEL_DIR} into ${OUT_DIR} …`);
  await FlagEmbedding.retrieveModel(EmbeddingModel.BGESmallENV15, OUT_DIR, true);
  if (!fs.existsSync(target)) {
    throw new Error(`[prefetch-fastembed] expected model at ${target} after download, not found`);
  }
  console.log("[prefetch-fastembed] done");
};
