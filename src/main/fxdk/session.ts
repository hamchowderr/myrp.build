import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import log from "electron-log/main";
import { treeKill, wrapperSpawnArgs, writeRestartWrapper } from "./restart-wrapper";

export interface FxDkSessionConfig {
  serverExePath: string;
  serverPath: string;
  serverCfgPath?: string;
  dataDir?: string; // directory containing resources/ — FXServer runs with cwd here
  logDir: string; // app.getPath('userData')
}

export interface ConsoleEntry {
  id: string;
  source: "stdout" | "stderr" | "system";
  text: string;
  timestamp: number;
}

export type SessionState = "idle" | "starting" | "running" | "stopping" | "error";

let entryCounter = 0;

function makeEntry(source: ConsoleEntry["source"], text: string): ConsoleEntry {
  return {
    id: `con-${Date.now()}-${++entryCounter}`,
    source,
    text,
    timestamp: Date.now(),
  };
}

export class FxDkSession extends EventEmitter {
  private _state: SessionState = "idle";
  /** The wrapper cmd.exe process (runs the restart-loop .bat) — see e4c. */
  private child: ChildProcess | null = null;
  /** PID of the wrapper cmd.exe; stable across FXServer restarts inside the loop. */
  private wrapperPid: number | null = null;
  private consoleBuffer: ConsoleEntry[] = [];
  private logStream: WriteStream | null = null;

  private static readonly MAX_BUFFER = 500;

  get state(): SessionState {
    return this._state;
  }

  getConsoleBuffer(): ConsoleEntry[] {
    return [...this.consoleBuffer];
  }

  private setState(state: SessionState): void {
    this._state = state;
    this.emit("stateChange", state);
  }

  private pushEntry(entry: ConsoleEntry): void {
    this.consoleBuffer.push(entry);
    if (this.consoleBuffer.length > FxDkSession.MAX_BUFFER) {
      this.consoleBuffer = this.consoleBuffer.slice(-FxDkSession.MAX_BUFFER);
    }
    this.emit("console", entry);

    // Also write to log file
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.write(
        `[${new Date(entry.timestamp).toISOString()}] [${entry.source}] ${entry.text}\n`,
      );
    }
  }

  emitSystem(text: string): void {
    this.pushEntry(makeEntry("system", text));
  }

  async start(config: FxDkSessionConfig): Promise<{ ok: boolean; error?: string }> {
    if (this._state === "running" || this._state === "starting") {
      return { ok: false, error: "FXServer is already running." };
    }

    this.setState("starting");
    this.consoleBuffer = [];

    try {
      const exeDir = dirname(config.serverExePath);
      const citizenDir = join(exeDir, "citizen");
      const serverCfg = config.serverCfgPath ?? join(config.serverPath, "server.cfg");

      // Use dataDir (where resources/ lives) as cwd, fall back to exeDir
      const cwd = config.dataDir ?? exeDir;

      // Set up log file
      const logDir = join(config.logDir, "fxserver-logs");
      await mkdir(logDir, { recursive: true });
      const logPath = join(logDir, `fxserver-${Date.now()}.log`);
      this.logStream = createWriteStream(logPath, { flags: "a" });

      // Build args: +set citizen_dir tells FXServer where its runtime files are
      const args = ["+set", "citizen_dir", citizenDir, "+exec", serverCfg];

      // Launch FXServer via the restart-loop wrapper (fivem-studio-e4c) rather
      // than FXServer.exe directly, so a txAdmin full-restart (which exits the
      // FXServer process) is relaunched by the loop. We track the wrapper
      // cmd.exe PID and tree-kill it on Stop so the loop cannot respawn.
      const batPath = await writeRestartWrapper(cwd, config.serverExePath, args);
      const { command, args: spawnArgs } = wrapperSpawnArgs(batPath);

      log.info(
        "[session] Launching via wrapper:",
        batPath,
        "exe:",
        config.serverExePath,
        "cwd:",
        cwd,
      );
      this.emitSystem(`Starting FXServer: ${config.serverExePath}`);
      this.emitSystem(`Restart-loop wrapper: ${batPath}`);
      this.emitSystem(`Data dir (cwd): ${cwd}`);

      const child = spawn(command, spawnArgs, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      this.child = child;
      this.wrapperPid = child.pid ?? null;

      // Stream stdout line by line
      let stdoutRemainder = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = stdoutRemainder + chunk.toString("utf-8");
        const lines = text.split(/\r?\n/);
        stdoutRemainder = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length > 0) {
            this.pushEntry(makeEntry("stdout", line));
          }
        }
      });

      // Stream stderr line by line
      let stderrRemainder = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = stderrRemainder + chunk.toString("utf-8");
        const lines = text.split(/\r?\n/);
        stderrRemainder = lines.pop() ?? "";
        for (const line of lines) {
          if (line.length > 0) {
            this.pushEntry(makeEntry("stderr", line));
          }
        }
      });

      // Wait a bit to detect immediate failures
      return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const timer = setTimeout(() => {
          this.setState("running");
          this.emitSystem("FXServer started successfully");
          resolve({ ok: true });
        }, 1000);

        child.on("error", (err) => {
          clearTimeout(timer);
          this.emitSystem(`Failed to start: ${err.message}`);
          this.cleanup();
          this.setState("error");
          resolve({ ok: false, error: err.message });
        });

        child.on("exit", (code, signal) => {
          if (this._state === "starting") {
            clearTimeout(timer);
            const msg = `FXServer exited immediately (code ${code}, signal ${signal})`;
            this.emitSystem(msg);
            this.cleanup();
            this.setState("error");
            resolve({ ok: false, error: msg });
          } else {
            // Flush remaining partial lines
            if (stdoutRemainder) this.pushEntry(makeEntry("stdout", stdoutRemainder));
            if (stderrRemainder) this.pushEntry(makeEntry("stderr", stderrRemainder));

            this.emitSystem(`FXServer exited (code ${code}, signal ${signal})`);
            this.cleanup();
            this.setState("idle");
          }
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitSystem(`Start failed: ${msg}`);
      this.cleanup();
      this.setState("error");
      return { ok: false, error: msg };
    }
  }

  async stop(): Promise<{ ok: boolean; error?: string }> {
    if (!this.child || this._state === "idle") {
      return { ok: false, error: "FXServer is not running." };
    }

    this.setState("stopping");
    this.emitSystem("Stopping FXServer...");

    return new Promise((resolve) => {
      const child = this.child!;
      const wrapperPid = this.wrapperPid;

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceKillTimer);
        this.emitSystem("FXServer stopped");
        this.cleanup();
        this.setState("idle");
        resolve({ ok: true });
      };

      // Fallback: if cmd.exe's exit event never arrives, force-kill the tree
      // again and settle anyway.
      const forceKillTimer = setTimeout(() => {
        log.warn("[session] Force-killing FXServer tree after 5s timeout");
        if (wrapperPid) void treeKill(wrapperPid);
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        finish();
      }, 5000);

      child.once("exit", finish);

      // Tree-kill the wrapper cmd.exe + its FXServer.exe child. A plain
      // SIGTERM on cmd.exe alone would leave FXServer.exe running and the loop
      // would respawn it — so we must take down the whole tree (e4c).
      if (wrapperPid) {
        void treeKill(wrapperPid).then((ok) => {
          if (!ok) {
            // taskkill failed (already gone?) — settle if the exit never fires.
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }
        });
      } else {
        try {
          child.kill("SIGKILL");
        } catch {
          finish();
        }
      }
    });
  }

  private cleanup(): void {
    this.child = null;
    this.wrapperPid = null;
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.end();
    }
    this.logStream = null;
  }

  destroy(): void {
    if (this.wrapperPid) {
      void treeKill(this.wrapperPid);
    }
    if (this.child) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    this.cleanup();
    this._state = "idle";
    this.removeAllListeners();
  }
}
