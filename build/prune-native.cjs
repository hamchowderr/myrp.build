/**
 * electron-builder afterPack hook — prune multi-platform native binaries.
 * onnxruntime-node and koffi both ship prebuilt binaries for
 * EVERY OS/arch (onnxruntime ~255M, koffi ~85M). A single-platform installer only
 * needs the target's binaries, so the rest is pure download bloat. This deletes
 * every platform/arch directory EXCEPT the one being packed, from the unpacked
 * native trees in app.asar.unpacked.
 *
 * Runs per (platform, arch) electron-builder pack. context gives:
 *   - appOutDir: the packed app dir (…/win-unpacked)
 *   - electronPlatformName: "win32" | "darwin" | "mas" | "linux"
 *   - arch: the builder-util Arch ENUM value (0 ia32, 1 x64, 2 armv7l, 3 arm64, 4 universal)
 *
 * Safe by construction: every step is existsSync-guarded and only ever DELETES
 * non-target dirs, so a layout change just makes it a no-op (never removes the
 * target, never touches anything outside these two module bin trees). Universal
 * mac builds keep both arches (no pruning) to stay correct.
 */
const fs = require("node:fs");
const path = require("node:path");

const ARCH_NAME = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };

// Windows-only DirectML (GPU) execution-provider DLLs that ship in onnxruntime's
// win32/x64 dir. fastembed.small runs on the CPU execution provider, the app's
// ONLY onnxruntime consumer — so these are never loaded (verified: an embed
// succeeds with them removed). Drop them from the SHIPPED build (~38 MB). If a
// future path ever requests the DML EP, stop dropping these.
const ONNX_GPU_DLLS = ["DirectML.dll", "dxcompiler.dll", "dxil.dll"];

/** Bytes in a directory tree (best-effort; for the freed-space log only). */
function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else
      try {
        total += fs.statSync(p).size;
      } catch {}
  }
  return total;
}

function rmDir(dir, label, freed) {
  try {
    const bytes = dirSize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    freed.bytes += bytes;
    freed.removed.push(label);
  } catch (err) {
    console.warn(`[prune-native] could not remove ${label}: ${err.message}`);
  }
}

module.exports = async function pruneNative(context) {
  const { appOutDir, electronPlatformName, arch } = context;
  const archName = ARCH_NAME[arch] ?? String(arch);

  if (archName === "universal") {
    console.log("[prune-native] universal build — keeping all arches, no pruning.");
    return;
  }

  // onnxruntime dir names: darwin | linux | win32 (mas → darwin).
  const onnxPlatform = electronPlatformName === "mas" ? "darwin" : electronPlatformName;
  const koffiPlatform = onnxPlatform; // koffi uses the same OS tokens (win32/darwin/linux)

  const unpacked = path.join(appOutDir, "resources", "app.asar.unpacked", "node_modules");
  const freed = { bytes: 0, removed: [] };

  // ── onnxruntime-node: bin/napi-v6/<platform>/<arch> — keep only the target ──
  const onnxRoot = path.join(unpacked, "onnxruntime-node", "bin", "napi-v6");
  if (fs.existsSync(onnxRoot)) {
    for (const plat of fs.readdirSync(onnxRoot)) {
      const platDir = path.join(onnxRoot, plat);
      if (!fs.statSync(platDir).isDirectory()) continue;
      for (const a of fs.readdirSync(platDir)) {
        if (plat === onnxPlatform && a === archName) continue; // the target — keep
        rmDir(path.join(platDir, a), `onnxruntime-node/${plat}/${a}`, freed);
      }
      // Drop the platform dir if it's now empty.
      if (fs.existsSync(platDir) && fs.readdirSync(platDir).length === 0)
        fs.rmSync(platDir, { recursive: true, force: true });
    }
  } else {
    console.warn(`[prune-native] onnxruntime napi-v6 not found at ${onnxRoot} — skipped.`);
  }

  // ── onnxruntime win32 GPU DLLs: unused (CPU EP) — drop from the kept dir ──
  if (onnxPlatform === "win32") {
    const keptDir = path.join(onnxRoot, "win32", archName);
    for (const dll of ONNX_GPU_DLLS) {
      const f = path.join(keptDir, dll);
      if (!fs.existsSync(f)) continue;
      try {
        const bytes = fs.statSync(f).size;
        fs.rmSync(f, { force: true });
        freed.bytes += bytes;
        freed.removed.push(`onnxruntime-node/win32/${archName}/${dll}`);
      } catch (err) {
        console.warn(`[prune-native] could not remove ${dll}: ${err.message}`);
      }
    }
  }

  // ── koffi: build/koffi/<platform>_<arch> — keep only the target ──
  // koffi may or may not be asarUnpacked depending on smartUnpack; only prunes
  // when it IS unpacked (real files). If packed inside app.asar, this no-ops.
  const koffiRoot = path.join(unpacked, "koffi", "build", "koffi");
  const koffiTarget = `${koffiPlatform}_${archName}`;
  if (fs.existsSync(koffiRoot)) {
    for (const name of fs.readdirSync(koffiRoot)) {
      const dir = path.join(koffiRoot, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      if (name === koffiTarget) continue; // the target — keep
      rmDir(dir, `koffi/${name}`, freed);
    }
  } else {
    console.log("[prune-native] koffi not unpacked (packed in app.asar) — koffi pruning skipped.");
  }

  // ── Chromium locale .pak files: the app is English-only — keep en-US only ──
  // Electron ships ~55 locale paks (~48 MB) for Chrome's own UI strings; Chromium
  // falls back to en-US.pak when a locale is absent, so dropping the rest is safe
  // (~46 MB). win/linux keep them at <appOutDir>/locales; mac nests them in the
  // app bundle's Resources (skip there — electronLanguages handles mac).
  const KEEP_LOCALES = new Set(["en-US.pak"]);
  const localesDir = path.join(appOutDir, "locales");
  if (
    electronPlatformName !== "darwin" &&
    electronPlatformName !== "mas" &&
    fs.existsSync(localesDir)
  ) {
    for (const f of fs.readdirSync(localesDir)) {
      if (!f.endsWith(".pak") || KEEP_LOCALES.has(f)) continue;
      const p = path.join(localesDir, f);
      try {
        const bytes = fs.statSync(p).size;
        fs.rmSync(p, { force: true });
        freed.bytes += bytes;
        freed.removed.push(`locales/${f}`);
      } catch (err) {
        console.warn(`[prune-native] could not remove locale ${f}: ${err.message}`);
      }
    }
  }

  const mb = (freed.bytes / 1024 / 1024).toFixed(1);
  console.log(
    `[prune-native] ${electronPlatformName}/${archName}: removed ${freed.removed.length} item(s), freed ~${mb} MB.`,
  );
  if (freed.removed.length) console.log(`[prune-native]   ${freed.removed.join(", ")}`);
};
