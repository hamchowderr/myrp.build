/**
 * Shared mutable state for the main process.
 * Passed by reference to IPC handler modules and the worker manager.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow, UtilityProcess } from "electron";
import { app } from "electron";
import { migrateSettings } from "../renderer/src/lib/server-registry";
import type { AppSettings, ServerContext, StreamMessage } from "../renderer/src/lib/types";
import { FxDkOrchestrator } from "./fxdk/fxdk-orchestrator";
import { GameViewManager } from "./fxdk/gameview-manager";
import { FxDkSession } from "./fxdk/session";

export const state = {
  mainWindow: null as BrowserWindow | null,
  cachedContext: null as ServerContext | null,
  persistentWorker: null as UtilityProcess | null,
  workerReady: false,
  // Current Mastra conversation thread (oeb) — set on generate, reused by
  // follow-up ai:message turns so memory carries context. Null = no session.
  mastraThreadId: null as string | null,
  // Abort controller for the in-flight Mastra run (wired to ai:cancel).
  mastraAbort: null as AbortController | null,
  // Resolver for a pending sensitive-tool approval (wired to chat:approve).
  // Set while a gated tool is awaiting the user's approve/decline.
  pendingApproval: null as ((approved: boolean) => void) | null,
};

export const fxdkSession = new FxDkSession();
export const gameViewManager = new GameViewManager();
export const orchestrator = new FxDkOrchestrator();

export function getSettingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

/**
 * Read settings from disk and normalize into registry shape (migrating legacy
 * flat settings on the fly). Returns an empty registry if the file is missing or
 * unreadable. This is the single main-process entry point for loading settings —
 * use it instead of JSON.parse'ing the file directly so migration always runs.
 */
export async function readSettings(): Promise<AppSettings> {
  try {
    return migrateSettings(JSON.parse(await readFile(getSettingsPath(), "utf-8")));
  } catch {
    return migrateSettings(null);
  }
}

export function sendStreamMessage(msg: StreamMessage): void {
  if (state.mainWindow && !state.mainWindow.isDestroyed()) {
    state.mainWindow.webContents.send("stream:message", msg);
  }
}
