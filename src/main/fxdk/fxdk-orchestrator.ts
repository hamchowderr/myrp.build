/**
 * FxDK Session Orchestrator — launches the FiveM game client using FxDK's
 * protocol, sets up shared memory + semaphores, waits for the game to
 * initialize its render surfaces, then feeds those surface handles into
 * GameViewManager for live frame capture.
 *
 * Replicates what FxDK's SDKGameProcessManager.cpp + SDKRender.cpp + SDKMain.cpp
 * do in C++, using our existing TypeScript/Koffi primitives.
 *
 * Architecture:
 *   FxDkOrchestrator
 *     ├── SharedMemory("CfxInitState")        → sets isReverseGame=true
 *     ├── SharedMemory("CfxReverseGameData")  → semaphores + surface ring buffer
 *     ├── FiveMProcessManager                 → CREATE_SUSPENDED → resume
 *     ├── LauncherTalk("launcherTalk")        → RPC bridge
 *     └── GameView ← surface handles + semaphores → GameViewManager → IPC → renderer
 */

import { EventEmitter } from "node:events";
import log from "electron-log/main";
import { disposeFxResources } from "./fxdk-cleanup";
import { readGameBuild, resolveFivemAppDir, resolveGameExecutable } from "./fxdk-resolve";
import {
  readGameSurfaces,
  writeCfxState,
  writeGamePid,
  writeReverseGameData,
} from "./fxdk-shm-init";
import { LauncherTalk } from "./launcher-talk";
import type { ProcessHandle } from "./process-manager";
import { FiveMProcessManager } from "./process-manager";
import { createInheritableMutex, createInheritableSemaphore } from "./semaphore";
import { SharedMemory } from "./shared-memory";
import { CfxState, MAX_SURFACES, ReverseGameData, RGD_OFFSETS } from "./structs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrchestratorState =
  | "idle"
  | "initializing"
  | "launching"
  | "waitingForGame"
  | "running"
  | "stopping"
  | "error";

export interface OrchestratorConfig {
  /** Absolute path to the FiveM executable (FiveM.exe or CitizenFX.exe). */
  fivemExePath: string;
  /** Server address to connect to. Default: 'localhost:30120'. */
  serverAddress?: string;
  /** Render width. Default: 1280. */
  width?: number;
  /** Render height. Default: 720. */
  height?: number;
  /** Target FPS limit sent to the game. Default: 60. */
  fpsLimit?: number;
  /** Number of surface slots in the ring buffer. Default: 4. */
  surfaceLimit?: number;
  /** Timeout (ms) waiting for the game to set RGD.inited. Default: 30000. */
  initTimeoutMs?: number;
}

interface OrchestratorEvents {
  stateChange: [state: OrchestratorState];
  gameReady: [];
  gameClosed: [];
  error: [error: Error];
  log: [
    entry: {
      level: "info" | "warn" | "error";
      message: string;
      timestamp: number;
    },
  ];
}

// ---------------------------------------------------------------------------
// FxDkOrchestrator
// ---------------------------------------------------------------------------

export class FxDkOrchestrator extends EventEmitter<OrchestratorEvents> {
  private _state: OrchestratorState = "idle";

  // Resources — all nullable, cleaned up in reverse order
  private initStateShm: SharedMemory | null = null;
  private reverseGameDataShm: SharedMemory | null = null;
  private inputMutex: unknown = null;
  private produceSema: unknown = null;
  private consumeSema: unknown = null;
  private processManager: FiveMProcessManager | null = null;
  private processHandle: ProcessHandle | null = null;
  private launcherTalk: LauncherTalk | null = null;

  // Resolved game state
  private _surfaceHandles: unknown[] = [];
  private _surfaceLimit = 0;
  private _width = 0;
  private _height = 0;

  // Polling timers
  private initPollTimer: ReturnType<typeof setInterval> | null = null;
  private livenessPollTimer: ReturnType<typeof setInterval> | null = null;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get state(): OrchestratorState {
    return this._state;
  }

  getSurfaceHandles(): {
    handles: unknown[];
    surfaceLimit: number;
  } | null {
    if (this._state !== "running" || this._surfaceHandles.length === 0) {
      return null;
    }
    return {
      handles: this._surfaceHandles,
      surfaceLimit: this._surfaceLimit,
    };
  }

  getSemaphoreHandles(): {
    consume: unknown;
    produce: unknown;
  } | null {
    if (!this.consumeSema || !this.produceSema) return null;
    return {
      consume: this.consumeSema,
      produce: this.produceSema,
    };
  }

  getGameDimensions(): { width: number; height: number } | null {
    if (this._state !== "running") return null;
    return { width: this._width, height: this._height };
  }

  /** Emit a log message to both electron-log and the 'log' event for the UI. */
  private emitLog(level: "info" | "warn" | "error", message: string): void {
    log[level](`[orchestrator] ${message}`);
    this.emit("log", { level, message, timestamp: Date.now() });
  }

  // ---------------------------------------------------------------------------
  // State machine: startGame
  // ---------------------------------------------------------------------------

  async startGame(config: OrchestratorConfig): Promise<{ ok: boolean; error?: string }> {
    if (this._state !== "idle" && this._state !== "error") {
      return { ok: false, error: `Cannot start from state "${this._state}"` };
    }

    const serverAddress = config.serverAddress ?? "localhost:30120";
    const width = config.width ?? 1280;
    const height = config.height ?? 720;
    const fpsLimit = config.fpsLimit ?? 60;
    // FxDK uses surfaceLimit=1 by default
    const surfaceLimit = Math.min(config.surfaceLimit ?? 1, MAX_SURFACES);
    const initTimeoutMs = config.initTimeoutMs ?? 30000;

    try {
      // ── Phase 1: Initialize shared memory + semaphores ──
      this.setState("initializing");

      // CfxState: tell the game we're in reverse (SDK) mode
      // Uses HostSharedData<CfxState>("CfxInitState") naming
      this.initStateShm = new SharedMemory("CfxInitState", CfxState);
      this.initStateShm.open();

      // Resolve FiveM.app dir + game build, then write all required CfxState
      // fields (reverse/SDK mode) at their correct offsets.
      const fivemAppDir = resolveFivemAppDir(config.fivemExePath);
      const gameBuild = readGameBuild(fivemAppDir, (l, m) => this.emitLog(l, m));
      writeCfxState(this.initStateShm, { fivemAppDir, gameBuild }, (l, m) => this.emitLog(l, m));

      // ReverseGameData: create + write initial state
      this.reverseGameDataShm = new SharedMemory("CfxReverseGameData", ReverseGameData);
      this.reverseGameDataShm.open();

      // Create inheritable mutex + semaphores (matching FxDK's SDKRender.cpp)
      this.inputMutex = createInheritableMutex();
      this.consumeSema = createInheritableSemaphore(0, surfaceLimit);
      this.produceSema = createInheritableSemaphore(surfaceLimit, surfaceLimit);

      // Write handles, dimensions, and config into ReverseGameData shared memory
      writeReverseGameData(
        this.reverseGameDataShm,
        {
          inputMutex: this.inputMutex,
          consumeSema: this.consumeSema,
          produceSema: this.produceSema,
          width,
          height,
          fpsLimit,
          surfaceLimit,
        },
        (l, m) => this.emitLog(l, m),
      );

      // Start LauncherTalk listener
      this.launcherTalk = new LauncherTalk("launcherTalk");
      this.launcherTalk.bind("hi", () => {
        this.emitLog("info", "Game said hi via LauncherTalk");
      });
      this.launcherTalk.bind("loading", () => {
        this.emitLog("info", "Game is loading...");
      });
      this.launcherTalk.bind("loadProgress", (progress: unknown) => {
        this.emitLog("info", `Load progress: ${JSON.stringify(progress)}`);
      });
      await this.launcherTalk.listen();
      this.emitLog("info", "LauncherTalk listening");

      // ── Phase 2: Resolve game executable + launch ──
      this.setState("launching");

      // Resolve the real game binary (MakeCfxSubProcess pattern from FxDK):
      // 1. Find CitizenFX_SubProcess_game_{build}_aslr.bin in FiveM.app/
      // 2. Copy it to data/cache/subprocess/ as GameRuntime.exe
      const gameExe = resolveGameExecutable(config.fivemExePath, (l, m) => this.emitLog(l, m));
      this.emitLog("info", `Launching: "${gameExe}" -windowed`);

      // FxDK only passes -windowed; connection is done later via LauncherTalk
      // CWD must be FiveM.app so the game can find DLLs (CoreRT.dll, etc.)
      // FxDK only sets CitizenFX_SDK_Guest=1 — NOT CitizenFX_ToolMode
      this.processManager = new FiveMProcessManager();
      this.processHandle = this.processManager.launch(gameExe, ["-windowed"], {
        suspended: true,
        cwd: fivemAppDir,
        // Pass 3 inheritable handles (FxDK's SDKGameProcessManager pattern)
        handleList: [this.inputMutex, this.consumeSema, this.produceSema],
      });

      // Write gamePid + initialGamePid to CfxState
      writeGamePid(this.initStateShm, this.processHandle.pid);
      this.emitLog("info", `Game launched (PID ${this.processHandle.pid}), resuming...`);

      // Resume the suspended process
      this.processManager.resume(this.processHandle);

      // ── Phase 3: Wait for game initialization ──
      this.setState("waitingForGame");

      const initResult = await this.waitForGameInit(initTimeoutMs, surfaceLimit);
      if (!initResult.ok) {
        throw new Error(initResult.error ?? "Game init timed out");
      }

      this._width = initResult.width!;
      this._height = initResult.height!;

      // ── Phase 4: Running ──
      this.setState("running");
      this.emit("gameReady");
      this.emitLog(
        "info",
        `Game ready — ${this._surfaceHandles.length} surfaces, ${this._width}x${this._height}`,
      );

      // Connect to server via LauncherTalk (FxDK pattern: game starts standalone,
      // then SDK tells it to connect)
      if (this.launcherTalk && serverAddress) {
        this.emitLog("info", `Connecting game to ${serverAddress}...`);
        this.launcherTalk.call("connectTo", serverAddress);
      }

      // Start liveness polling
      this.startLivenessPoll();

      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitLog("error", `startGame failed: ${msg}`);
      this.cleanup();
      this.setState("error");
      if (this.listenerCount("error") > 0) {
        this.emit("error", err instanceof Error ? err : new Error(msg));
      }
      return { ok: false, error: msg };
    }
  }

  // ---------------------------------------------------------------------------
  // State machine: stopGame
  // ---------------------------------------------------------------------------

  async stopGame(): Promise<{ ok: boolean; error?: string }> {
    if (this._state === "idle") {
      return { ok: true };
    }

    this.setState("stopping");
    this.emitLog("info", "Stopping game...");

    try {
      // Terminate game process
      if (this.processManager && this.processHandle) {
        try {
          if (this.processManager.isRunning(this.processHandle)) {
            this.processManager.terminate(this.processHandle);
          }
        } catch {
          // Best-effort — process may have already exited
        }
      }

      this.cleanup();
      this.setState("idle");
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitLog("error", `stopGame failed: ${msg}`);
      this.cleanup();
      this.setState("error");
      return { ok: false, error: msg };
    }
  }

  /** Clean up all resources during app shutdown. */
  destroy(): void {
    this.cleanup();
  }

  // ---------------------------------------------------------------------------
  // Internal: Wait for game init (polls RGD.inited)
  // ---------------------------------------------------------------------------

  private waitForGameInit(
    timeoutMs: number,
    surfaceLimit: number,
  ): Promise<{
    ok: boolean;
    error?: string;
    width?: number;
    height?: number;
  }> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      let pollCount = 0;
      this.initPollTimer = setInterval(() => {
        pollCount++;
        // Check if process exited early
        if (
          this.processManager &&
          this.processHandle &&
          !this.processManager.isRunning(this.processHandle)
        ) {
          this.clearInitPoll();
          this.emitLog(
            "warn",
            `Game process exited after ${Date.now() - startTime}ms (${pollCount} polls)`,
          );
          resolve({
            ok: false,
            error: "Game process exited before initialization completed",
          });
          return;
        }
        if (pollCount <= 3 || pollCount % 50 === 0) {
          this.emitLog(
            "info",
            `Init poll #${pollCount} — process alive, elapsed ${Date.now() - startTime}ms`,
          );
        }

        // Check timeout
        if (Date.now() - startTime > timeoutMs) {
          this.clearInitPoll();
          resolve({
            ok: false,
            error: `Game did not initialize within ${timeoutMs}ms`,
          });
          return;
        }

        // Poll RGD.inited
        if (!this.reverseGameDataShm) {
          this.clearInitPoll();
          resolve({ ok: false, error: "ReverseGameData not available" });
          return;
        }

        try {
          const initedBuf = this.reverseGameDataShm.read(RGD_OFFSETS.inited, 1);
          if (initedBuf[0] !== 1) return; // Not yet initialized

          // Game is initialized! Read surface handles and dimensions.
          this.clearInitPoll();

          const { width, height, handles } = readGameSurfaces(
            this.reverseGameDataShm,
            surfaceLimit,
          );
          this._surfaceHandles = handles;
          this._surfaceLimit = surfaceLimit;

          resolve({ ok: true, width, height });
        } catch (err) {
          // Non-fatal read error — retry next tick
          this.emitLog("warn", `init poll read error: ${err instanceof Error ? err.message : err}`);
        }
      }, 100); // Poll every 100ms
    });
  }

  private clearInitPoll(): void {
    if (this.initPollTimer) {
      clearInterval(this.initPollTimer);
      this.initPollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: Liveness polling
  // ---------------------------------------------------------------------------

  private startLivenessPoll(): void {
    this.livenessPollTimer = setInterval(() => {
      if (
        this.processManager &&
        this.processHandle &&
        !this.processManager.isRunning(this.processHandle)
      ) {
        this.emitLog("info", "Game process exited");
        this.stopLivenessPoll();
        this.cleanup();
        this.setState("idle");
        this.emit("gameClosed");
      }
    }, 2000); // Check every 2 seconds
  }

  private stopLivenessPoll(): void {
    if (this.livenessPollTimer) {
      clearInterval(this.livenessPollTimer);
      this.livenessPollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: Cleanup (reverse order)
  // ---------------------------------------------------------------------------

  private cleanup(): void {
    this.clearInitPoll();
    this.stopLivenessPoll();

    // Close/terminate/dispose every allocated resource in reverse order.
    disposeFxResources(
      {
        launcherTalk: this.launcherTalk,
        processManager: this.processManager,
        processHandle: this.processHandle,
        produceSema: this.produceSema,
        consumeSema: this.consumeSema,
        inputMutex: this.inputMutex,
        reverseGameDataShm: this.reverseGameDataShm,
        initStateShm: this.initStateShm,
      },
      (l, m) => this.emitLog(l, m),
    );

    // Null out fields now that their resources are released.
    this.launcherTalk = null;
    this.processHandle = null;
    this.processManager = null;
    this.produceSema = null;
    this.consumeSema = null;
    this.inputMutex = null;
    this.reverseGameDataShm = null;
    this.initStateShm = null;

    // Clear resolved state
    this._surfaceHandles = [];
    this._surfaceLimit = 0;
    this._width = 0;
    this._height = 0;
  }

  // ---------------------------------------------------------------------------
  // Internal: State transitions
  // ---------------------------------------------------------------------------

  private setState(state: OrchestratorState): void {
    this._state = state;
    this.emit("stateChange", state);
    this.emitLog("info", `State → ${state}`);
  }
}
