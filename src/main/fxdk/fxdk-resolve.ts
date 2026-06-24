/**
 * FxDK path + executable resolution helpers.
 *
 * Pure functions extracted from FxDkOrchestrator (behavior-preserving). They
 * replicate FxDK's path-resolution / MakeCfxSubProcess logic and take a logging
 * callback so the orchestrator can keep routing messages to electron-log + the
 * 'log' event exactly as before.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Logging callback signature matching FxDkOrchestrator's emitLog. */
export type FxDkLogFn = (level: "info" | "warn" | "error", message: string) => void;

/**
 * Resolve the FiveM.app directory from the configured exe path or LOCALAPPDATA.
 */
export function resolveFivemAppDir(fivemExePath: string): string {
  if (fivemExePath.includes("FiveM.app")) {
    const idx = fivemExePath.indexOf("FiveM.app");
    return fivemExePath.substring(0, idx + "FiveM.app".length);
  }
  const localAppData = process.env.LOCALAPPDATA ?? join(process.env.APPDATA ?? "", "..", "Local");
  return join(localAppData, "FiveM", "FiveM.app");
}

/**
 * Read the SavedBuildNumber from CitizenFX.ini in FiveM.app/.
 * Falls back to 3258 if the file doesn't exist or can't be parsed.
 */
export function readGameBuild(fivemAppDir: string, log: FxDkLogFn): number {
  const iniPath = join(fivemAppDir, "CitizenFX.ini");
  if (existsSync(iniPath)) {
    const ini = readFileSync(iniPath, "utf-8");
    const match = ini.match(/SavedBuildNumber=(\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  log("warn", "Could not read SavedBuildNumber, defaulting to 3258");
  return 3258;
}

/**
 * Resolve the correct game binary using FxDK's MakeCfxSubProcess logic:
 * 1. Read the game build from CitizenFX.ini (SavedBuildNumber)
 * 2. Find CitizenFX_SubProcess_game_{build}_aslr.bin in FiveM.app/
 * 3. Copy it to data/cache/subprocess/FiveM_GameRuntime.exe
 * 4. Return the path to the copy
 *
 * If fivemExePath already points to a valid .exe, use it as-is (allows override).
 */
export function resolveGameExecutable(fivemExePath: string, log: FxDkLogFn): string {
  // If caller provided a specific .exe and it exists, use it directly
  if (
    fivemExePath.endsWith(".exe") &&
    !fivemExePath.endsWith("FiveM.exe") &&
    !fivemExePath.endsWith("FiveM_GTAProcess.exe") &&
    existsSync(fivemExePath)
  ) {
    log("info", `Using provided executable: ${fivemExePath}`);
    return fivemExePath;
  }

  const fivemAppDir = resolveFivemAppDir(fivemExePath);
  log("info", `FiveM.app directory: ${fivemAppDir}`);

  // Read game build from CitizenFX.ini
  const gameBuild = String(readGameBuild(fivemAppDir, log));
  log("info", `Game build: ${gameBuild}`);

  // Find the .bin file
  const binName = `CitizenFX_SubProcess_game_${gameBuild}_aslr.bin`;
  const binPath = join(fivemAppDir, binName);
  if (!existsSync(binPath)) {
    throw new Error(`Game binary not found: ${binPath}. Is FiveM installed and up to date?`);
  }

  // Copy to subprocess cache as GameRuntime.exe (like MakeCfxSubProcess)
  const subprocessDir = join(fivemAppDir, "data", "cache", "subprocess");
  mkdirSync(subprocessDir, { recursive: true });

  const destPath = join(subprocessDir, "FiveM_GameRuntime.exe");
  log("info", `Copying ${binName} → FiveM_GameRuntime.exe`);
  copyFileSync(binPath, destPath);

  return destPath;
}
