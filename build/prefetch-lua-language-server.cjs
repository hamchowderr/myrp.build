/**
 * Build-time prefetch of lua-language-server.
 *
 * Runs (with the fastembed prefetch) as electron-builder's beforePack hook. Downloads
 * the platform's LuaLS release into build/lua-language-server so the extraResources
 * entry can bundle it, and the runtime (index.ts LUALS_PATH) can point the Workspace
 * LSP + the validator's `--check` gate at it — no network needed at runtime.
 *
 * Pinned to the version verified for the `--check` gate + Workspace lsp wiring.
 * Idempotent: skips if already extracted (e.g. vendored in dev).
 */
const path = require("node:path");
const fs = require("node:fs");
const https = require("node:https");
const { execFileSync } = require("node:child_process");

const VERSION = "3.18.2";
const OUT_DIR = path.join(__dirname, "lua-language-server");

/** Map the current platform/arch to its LuaLS release asset + archive kind. */
function assetFor() {
  const map = {
    "win32-x64": [`lua-language-server-${VERSION}-win32-x64.zip`, "zip"],
    "win32-ia32": [`lua-language-server-${VERSION}-win32-ia32.zip`, "zip"],
    "darwin-arm64": [`lua-language-server-${VERSION}-darwin-arm64.tar.gz`, "tar"],
    "darwin-x64": [`lua-language-server-${VERSION}-darwin-x64.tar.gz`, "tar"],
    "linux-x64": [`lua-language-server-${VERSION}-linux-x64.tar.gz`, "tar"],
    "linux-arm64": [`lua-language-server-${VERSION}-linux-arm64.tar.gz`, "tar"],
  };
  return map[`${process.platform}-${process.arch}`];
}

/** Download with redirect-following (GitHub release assets 302 to a CDN). */
function download(url, dest) {
  return new Promise((res, rej) => {
    const get = (u) =>
      https
        .get(u, (r) => {
          if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
            r.resume();
            return get(r.headers.location);
          }
          if (r.statusCode !== 200) {
            rej(new Error(`HTTP ${r.statusCode} for ${u}`));
            return;
          }
          const file = fs.createWriteStream(dest);
          r.pipe(file);
          file.on("finish", () => file.close(() => res()));
          file.on("error", rej);
        })
        .on("error", rej);
    get(url);
  });
}

module.exports = async function prefetchLuaLanguageServer() {
  const exe = process.platform === "win32" ? "lua-language-server.exe" : "lua-language-server";
  if (fs.existsSync(path.join(OUT_DIR, "bin", exe))) {
    console.log(`[prefetch-luals] already present at ${OUT_DIR} — skipping download`);
    return;
  }
  const asset = assetFor();
  if (!asset) {
    console.warn(
      `[prefetch-luals] no LuaLS asset for ${process.platform}-${process.arch} — skipping (Lua LSP unavailable)`,
    );
    return;
  }
  const [name, kind] = asset;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const archive = path.join(__dirname, name);
  const url = `https://github.com/LuaLS/lua-language-server/releases/download/${VERSION}/${name}`;
  console.log(`[prefetch-luals] downloading ${name} …`);
  await download(url, archive);
  console.log(`[prefetch-luals] extracting into ${OUT_DIR} …`);
  if (kind === "zip") {
    // Windows: no bundled unzip in Node — use PowerShell's Expand-Archive.
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archive}' -DestinationPath '${OUT_DIR}' -Force`,
      ],
      { stdio: "inherit" },
    );
  } else {
    // macOS/Linux: native tar handles .tar.gz.
    execFileSync("tar", ["-xzf", archive, "-C", OUT_DIR], { stdio: "inherit" });
  }
  fs.rmSync(archive, { force: true });
  if (!fs.existsSync(path.join(OUT_DIR, "bin", exe))) {
    throw new Error(`[prefetch-luals] ${exe} not found under ${OUT_DIR}/bin after extract`);
  }
  console.log("[prefetch-luals] done");
};
