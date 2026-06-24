/**
 * FXServer restart-loop wrapper (fivem-studio-e4c).
 *
 * PROBLEM: launching FXServer.exe DIRECTLY means a txAdmin "full restart" (which
 * exits the FXServer process) leaves the server dead — nothing relaunches it,
 * because the app, not txAdmin's own monitor, owns the process.
 *
 * FIX: launch FXServer.exe from a generated `myrp-fxserver-loop.bat` whose body
 * is a `:loop … goto loop` so that whenever FXServer.exe exits (txAdmin restart,
 * crash), the wrapper immediately relaunches it with the same args — mirroring
 * the behaviour of txAdmin's own start.bat monitor loop.
 *
 * RECONCILIATION: because the loop respawns FXServer.exe, an app-side Stop that
 * only kills FXServer.exe would be instantly undone by the loop. So Stop must
 * tear down the WHOLE tree — the cmd.exe running the .bat AND its FXServer.exe
 * child (`taskkill /T /F /PID <wrapperPid>`). This module centralises both the
 * wrapper generation and the tree-kill / orphan-detection so FxDkSession and
 * server-control drive one consistent implementation.
 */

import { exec } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import log from "electron-log/main";

const execAsync = promisify(exec);

/** Wrapper batch filename — unique enough to detect via the cmd command line. */
export const WRAPPER_BAT_NAME = "myrp-fxserver-loop.bat";

/**
 * Write the restart-loop wrapper batch into `dataDir` and return its absolute
 * path. The .bat re-execs FXServer.exe with the given args on every exit.
 *
 * `%~dp0` is not used for the exe — we bake the absolute exe path + args so the
 * wrapper is independent of where it is invoked from. We `cd /d` into the data
 * dir first so FXServer's cwd matches the direct-spawn behaviour (resources/).
 */
export async function writeRestartWrapper(
  dataDir: string,
  exePath: string,
  args: string[],
): Promise<string> {
  const batPath = join(dataDir, WRAPPER_BAT_NAME);
  // Quote the exe and every arg so paths with spaces survive cmd parsing.
  const quotedExe = `"${exePath}"`;
  const quotedArgs = args.map((a) => (a.includes(" ") || a.includes('"') ? `"${a}"` : a));
  const cmdLine = [quotedExe, ...quotedArgs].join(" ");
  const body = [
    "@echo off",
    "rem myRP.build FXServer restart-loop wrapper (fivem-studio-e4c).",
    "rem Relaunches FXServer.exe whenever it exits so a txAdmin full-restart",
    "rem brings the server back. The app's Stop tree-kills this wrapper.",
    `cd /d "${dataDir}"`,
    ":loop",
    cmdLine,
    "rem Small pause so a tight crash-loop does not spin the CPU.",
    "timeout /t 1 /nobreak >nul",
    "goto loop",
    "",
  ].join("\r\n");
  await writeFile(batPath, body, "utf-8");
  return batPath;
}

/**
 * Build the spawn descriptor for the wrapper. We launch it through cmd.exe so
 * the parent PID we track is the cmd.exe running the loop — that PID is stable
 * across FXServer restarts (the loop body changes child PIDs, cmd.exe does not),
 * and `taskkill /T` on it cleans up the whole tree.
 */
export function wrapperSpawnArgs(batPath: string): { command: string; args: string[] } {
  // `/c` so cmd exits when the batch's loop is killed; the batch itself never
  // returns under normal operation (infinite loop) — it ends only via taskkill.
  return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", batPath] };
}

/**
 * Tree-kill a wrapper (cmd.exe) PID and all descendants (FXServer.exe). Returns
 * true if taskkill reported success. `/T` = tree, `/F` = force.
 */
export async function treeKill(pid: number): Promise<boolean> {
  try {
    await execAsync(`taskkill /PID ${pid} /T /F`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find orphaned wrapper cmd.exe PIDs (a previous run's loop still alive). We
 * match cmd.exe processes whose command line references our wrapper batch.
 * Uses WMIC-free PowerShell CIM so it works on modern Windows where wmic is
 * deprecated/absent.
 */
export async function findOrphanWrapperPids(): Promise<number[]> {
  const pids: number[] = [];
  try {
    // CommandLine contains the .bat name for our wrapper cmd.exe processes.
    const psCmd =
      "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | " +
      `Where-Object { $_.CommandLine -like '*${WRAPPER_BAT_NAME}*' } | ` +
      "Select-Object -ExpandProperty ProcessId";
    const { stdout } = await execAsync(`powershell -NoProfile -NonInteractive -Command "${psCmd}"`);
    for (const line of stdout.trim().split(/\r?\n/)) {
      const pid = Number.parseInt(line.trim(), 10);
      if (!Number.isNaN(pid)) pids.push(pid);
    }
  } catch (err) {
    log.warn("[restart-wrapper] orphan wrapper scan failed:", err);
  }
  return pids;
}
