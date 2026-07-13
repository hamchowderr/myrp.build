/**
 * Combined electron-builder beforePack hook — prefetch every bundled binary asset
 * into build/ so the extraResources / asarUnpack entries can pick them up:
 *   - fastembed bge-small weights
 *   - lua-language-server
 * Each sub-prefetch is idempotent (skips when already present).
 */
const prefetchFastembed = require("./prefetch-fastembed-model.cjs");
const prefetchLuaLanguageServer = require("./prefetch-lua-language-server.cjs");

module.exports = async function prefetchBundledAssets(context) {
  await prefetchFastembed(context);
  await prefetchLuaLanguageServer(context);
};
