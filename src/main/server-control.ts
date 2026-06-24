/**
 * FXServer lifecycle control — start/stop the local server process.
 *
 * Extracted from the `server:start` / `server:stop` IPC handlers so BOTH the
 * user-facing buttons (ipc/fxdk.ts) AND the approval-gated agent tools
 * (mastra/tools/server-lifecycle.ts) drive the same implementation. The agent
 * runs in the main process, so it calls these directly.
 *
 * See vault: "FiveM Studio - Agent Server Interaction" (the 2026-05-23 contract,
 * amended 2026-05-26 to let the agent manage server lifecycle behind approval).
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { app } from "electron";
import log from "electron-log/main";
import { getActiveServer } from "../renderer/src/lib/server-registry";
import { findResourcesDataDir } from "./context";
import { findOrphanWrapperPids, treeKill } from "./fxdk/restart-wrapper";
import { fxdkSession, readSettings, state } from "./shared-state";

const execAsync = promisify(exec);

/** PIDs of any running FXServer.exe processes (Windows tasklist). */
async function findFxServerPids(): Promise<number[]> {
  const pids: number[] = [];
  try {
    const { stdout } = await execAsync('tasklist /fi "IMAGENAME eq FXServer.exe" /fo csv /nh');
    for (const line of stdout.trim().split("\n")) {
      if (line.toLowerCase().includes("fxserver.exe")) {
        const cols = line.split(",");
        const pid = cols[1] ? Number.parseInt(cols[1].replace(/"/g, ""), 10) : Number.NaN;
        if (!Number.isNaN(pid)) pids.push(pid);
      }
    }
  } catch {
    // tasklist failed — treat as none found
  }
  return pids;
}

/** Is FXServer.exe running, and on what PID (first match)? */
export async function checkFxServerProcess(): Promise<{ running: boolean; pid?: number }> {
  const pids = await findFxServerPids();
  return pids.length > 0 ? { running: true, pid: pids[0] } : { running: false };
}

/**
 * Start the local FXServer via FxDkSession. Reads settings from disk, kills any
 * orphaned FXServer.exe first, auto-detects the resources data dir, then spawns.
 * Idempotent-ish: FxDkSession refuses to start if already running.
 */
export async function startFxServer(): Promise<{ ok: boolean; error?: string }> {
  try {
    const server = getActiveServer(await readSettings());
    if (!server?.serverExePath) {
      return { ok: false, error: "FXServer executable path not configured in Settings." };
    }

    // Kill any orphaned restart-loop wrappers FIRST (e4c) — a stale wrapper
    // cmd.exe would otherwise respawn the FXServer.exe we kill next. Tree-kill
    // takes down the wrapper and its child together.
    for (const pid of await findOrphanWrapperPids()) {
      log.info(`[server-control] Tree-killing orphaned wrapper PID ${pid} before start`);
      await treeKill(pid);
    }
    // Then kill any remaining orphaned FXServer processes (e.g. launched
    // directly by a prior app version, or a child whose wrapper already died).
    for (const pid of await findFxServerPids()) {
      log.info(`[server-control] Killing orphaned FXServer PID ${pid} before start`);
      await execAsync(`taskkill /PID ${pid} /F`).catch(() => {});
    }

    const dataDir = await findResourcesDataDir(server.serverPath, server.serverExePath);
    if (dataDir) {
      log.info("[server-control] Auto-detected data dir:", dataDir);
    } else {
      log.warn("[server-control] Could not auto-detect resources dir, falling back to exe dir");
    }

    return await fxdkSession.start({
      serverExePath: server.serverExePath,
      serverPath: server.serverPath,
      serverCfgPath: state.cachedContext?.serverCfgPath,
      dataDir: dataDir ?? undefined,
      logDir: app.getPath("userData"),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Stop the local FXServer. Prefers stopping the FxDkSession child (graceful),
 * falls back to taskkill for an externally-launched FXServer.exe.
 */
export async function stopFxServer(): Promise<{ ok: boolean; error?: string }> {
  if (fxdkSession.state !== "idle") {
    return fxdkSession.stop();
  }

  // No managed session — tear down any orphaned restart-loop wrappers FIRST
  // (e4c) so the loop can't respawn the FXServer.exe we kill next.
  const wrapperPids = await findOrphanWrapperPids();
  for (const pid of wrapperPids) {
    log.info(`[server-control] Tree-killing external wrapper PID ${pid}`);
    await treeKill(pid);
  }

  const pids = await findFxServerPids();
  if (pids.length === 0 && wrapperPids.length === 0) {
    return { ok: false, error: "No FXServer process found." };
  }
  try {
    for (const pid of pids) {
      log.info(`[server-control] Killing external FXServer PID ${pid}`);
      await execAsync(`taskkill /PID ${pid} /F`).catch(() => {});
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
