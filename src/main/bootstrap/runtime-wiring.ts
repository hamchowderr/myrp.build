/**
 * Runtime event wiring — orchestrator (game view) + FxDK session events.
 *
 * Behavior-preserving extraction from src/main/index.ts. wireRuntimeEvents()
 * registers the exact same orchestrator/fxdkSession listeners as before,
 * including the refcounted powerSaveBlocker holders which are
 * only ever touched here.
 */

import type { ConsoleEntry } from "../fxdk/session";
import { keepAwake, notify } from "../native-features";
import { fxdkSession, gameViewManager, orchestrator, state } from "../shared-state";

// Refcounted powerSaveBlocker holders: keep the system awake
// while the FXServer runs and while the embedded game-view is active.
let serverAwakeRelease: (() => void) | null = null;
let gameAwakeRelease: (() => void) | null = null;

/**
 * Wire orchestrator + FxDK session events to the renderer and to the
 * powerSaveBlocker / notification side-effects. Call once after createWindow().
 */
export function wireRuntimeEvents(): void {
  // Wire orchestrator: auto-start frame capture when game is ready
  orchestrator.on("gameReady", () => {
    if (!gameAwakeRelease) gameAwakeRelease = keepAwake("game-view");
    const handles = orchestrator.getSurfaceHandles();
    const semas = orchestrator.getSemaphoreHandles();
    const dims = orchestrator.getGameDimensions();
    if (handles && semas && dims) {
      gameViewManager.startWithHandles(
        handles.handles,
        semas.consume,
        semas.produce,
        handles.surfaceLimit,
        dims.width,
        dims.height,
      );
    }
  });
  orchestrator.on("gameClosed", () => {
    gameViewManager.stop();
    gameAwakeRelease?.();
    gameAwakeRelease = null;
  });
  orchestrator.on("stateChange", (s: string) => {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send("stream:orchestratorState", s);
    }
  });
  orchestrator.on("log", (entry: { level: string; message: string; timestamp: number }) => {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send("stream:orchestratorLog", entry);
    }
  });

  // Forward FxDK session console events to renderer
  fxdkSession.on("console", (entry: ConsoleEntry) => {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send("stream:serverConsole", entry);
    }
  });

  fxdkSession.on("stateChange", (s: string) => {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send("stream:serverState", s);
    }
    // Keep the system awake while the server runs; toast on start/stop.
    if (s === "running" && !serverAwakeRelease) {
      serverAwakeRelease = keepAwake("fxserver");
      notify("myRP.build", "FXServer is running");
    } else if ((s === "idle" || s === "error") && serverAwakeRelease) {
      serverAwakeRelease();
      serverAwakeRelease = null;
      if (s === "idle") notify("myRP.build", "FXServer stopped");
    }
  });
}
