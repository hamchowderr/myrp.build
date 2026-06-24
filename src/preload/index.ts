import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  ConsoleEntry,
  GameFrameMessage,
  GameViewCapabilities,
  GameViewStartOptions,
  GameViewStats,
  ManifestSummary,
  OrchestratorConfig,
  OrchestratorLogEntry,
  OrchestratorState,
  ScaffoldResult,
  ServerPingResult,
} from "../renderer/src/lib/types";

const api = {
  // Dev-mode bypass flag (lwt) — true when the renderer should skip Clerk sign-in
  // and Supabase billing. __DEV_BYPASS__ is a Vite-injected BUILD-TIME literal
  // (electron.vite.config.ts) — `true` only in `electron-vite dev|preview` with
  // FIVEM_STUDIO_DEV=1 in .env, `false` in every packaged build. Read at build
  // time rather than from process.argv because process.argv is attacker-controlled
  // at launch (`FiveM Studio.exe --fivem-dev-bypass=1` would otherwise flip this).
  isDevBypass: __DEV_BYPASS__,

  // Dialogs
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke("dialog:selectFolder"),
  selectFile: (): Promise<string | null> => ipcRenderer.invoke("dialog:selectFile"),

  // Settings
  saveSettings: (settings: AppSettings): Promise<void> =>
    ipcRenderer.invoke("settings:save", settings),
  loadSettings: (): Promise<AppSettings | null> => ipcRenderer.invoke("settings:load"),
  scaffoldServer: (parentDir: string, name: string): Promise<ScaffoldResult | { error: string }> =>
    ipcRenderer.invoke("servers:scaffold", parentDir, name),

  // Server context
  findServerPaths: (): Promise<string[]> => ipcRenderer.invoke("context:findServers"),
  findServerExe: (serverPath: string): Promise<string | null> =>
    ipcRenderer.invoke("context:findServerExe", serverPath),
  detectContext: (serverPath: string) => ipcRenderer.invoke("context:detect", serverPath),

  // AI-Elements chat (v6 UIMessage stream over IPC — drives useChat transport)
  chat: {
    start: (payload: {
      text: string;
      chatId: string;
      model?: string;
      accessToken?: string;
      workspaceId?: string;
    }): Promise<void> => ipcRenderer.invoke("chat:start", payload),
    cancel: (): Promise<void> => ipcRenderer.invoke("chat:cancel"),
    approve: (approved: boolean): Promise<void> => ipcRenderer.invoke("chat:approve", approved),
    clone: (payload: {
      sourceThreadId: string;
      newThreadId: string;
      accessToken?: string;
      workspaceId?: string;
    }): Promise<{ ok: boolean; copied?: number; error?: string }> =>
      ipcRenderer.invoke("chat:clone", payload),
    // Conversation management (eh2g): list / load / rename / delete / search /
    // archive persisted threads.
    listThreads: (payload: {
      accessToken?: string;
      workspaceId?: string;
    }): Promise<{
      ok: boolean;
      threads?: {
        id: string;
        title: string | null;
        updatedAt: string;
        archivedAt: string | null;
      }[];
      error?: string;
    }> => ipcRenderer.invoke("chat:listThreads", payload),
    searchThreads: (payload: {
      query: string;
      accessToken?: string;
      workspaceId?: string;
    }): Promise<{
      ok: boolean;
      results?: {
        id: string;
        title: string | null;
        snippet: string | null;
        updatedAt: string;
        archivedAt: string | null;
      }[];
      error?: string;
    }> => ipcRenderer.invoke("chat:searchThreads", payload),
    setThreadArchived: (payload: {
      threadId: string;
      archived: boolean;
      accessToken?: string;
      workspaceId?: string;
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("chat:setThreadArchived", payload),
    loadThread: (payload: {
      threadId: string;
      accessToken?: string;
      workspaceId?: string;
    }): Promise<{ ok: boolean; messages?: unknown[]; error?: string }> =>
      ipcRenderer.invoke("chat:loadThread", payload),
    renameThread: (payload: {
      threadId: string;
      title: string;
      accessToken?: string;
      workspaceId?: string;
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("chat:renameThread", payload),
    deleteThread: (payload: {
      threadId: string;
      accessToken?: string;
      workspaceId?: string;
    }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("chat:deleteThread", payload),
    suggestFollowups: (payload: {
      threadId: string;
      accessToken?: string;
      workspaceId?: string;
    }): Promise<{ ok: boolean; suggestions?: string[]; error?: string }> =>
      ipcRenderer.invoke("chat:suggestFollowups", payload),
    onApprovalPending: (callback: () => void): (() => void) => {
      const handler = (): void => callback();
      ipcRenderer.on("chat:approval_pending", handler);
      return () => ipcRenderer.removeListener("chat:approval_pending", handler);
    },
    onChunk: (callback: (chunk: unknown) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, chunk: unknown): void => callback(chunk);
      ipcRenderer.on("chat:chunk", handler);
      return () => ipcRenderer.removeListener("chat:chunk", handler);
    },
    onDone: (callback: (payload: { generationId: string | null }) => void): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        payload: { generationId: string | null } | null,
      ): void => callback(payload ?? { generationId: null });
      ipcRenderer.on("chat:done", handler);
      return () => ipcRenderer.removeListener("chat:done", handler);
    },
    onError: (callback: (message: string) => void): (() => void) => {
      const handler = (_e: Electron.IpcRendererEvent, message: string): void => callback(message);
      ipcRenderer.on("chat:error", handler);
      return () => ipcRenderer.removeListener("chat:error", handler);
    },
    onResult: (
      callback: (result: import("../renderer/src/lib/types").GenerationResult) => void,
    ): (() => void) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        result: import("../renderer/src/lib/types").GenerationResult,
      ): void => callback(result);
      ipcRenderer.on("chat:result", handler);
      return () => ipcRenderer.removeListener("chat:result", handler);
    },
  },

  // Feedback capture (zhk.9): rate a logged generation thumbs up/down.
  feedback: {
    rate: (generationId: string, rating: "up" | "down"): Promise<boolean> =>
      ipcRenderer.invoke("feedback:rate", { generationId, rating }),
  },

  // Server backup to GitHub (1yef). gitInit (1yef.1): git-init a server folder +
  // .gitignore. github* + linkRepo (1yef.2): connect a GitHub account (token from
  // the renderer's linkIdentity) and create/link one repo per server.
  backup: {
    gitInit: (
      serverPath?: string,
    ): Promise<{
      ok: boolean;
      alreadyRepo: boolean;
      gitignoreWritten: boolean;
      secretWarnings: { line: number; directive: string }[];
      error?: string;
    }> => ipcRenderer.invoke("backup:gitInit", serverPath),
    githubStatus: (): Promise<{ connected: boolean; login?: string }> =>
      ipcRenderer.invoke("backup:githubStatus"),
    githubConnect: (token: string): Promise<{ ok: boolean; login?: string; error?: string }> =>
      ipcRenderer.invoke("backup:githubConnect", token),
    githubDisconnect: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("backup:githubDisconnect"),
    linkRepo: (opts: {
      serverPath?: string;
      repoName?: string;
      isPrivate?: boolean;
      org?: string;
      accessToken?: string;
      workspaceId?: string;
    }): Promise<{
      ok: boolean;
      repoUrl?: string;
      htmlUrl?: string;
      fullName?: string;
      isPrivate?: boolean;
      cloudSynced?: boolean;
      secretWarnings?: { line: number; directive: string }[];
      error?: string;
    }> => ipcRenderer.invoke("backup:linkRepo", opts),
    repoStatus: (serverPath?: string): Promise<{ linked: boolean; remoteUrl?: string }> =>
      ipcRenderer.invoke("backup:repoStatus", serverPath),
    commitPush: (opts: {
      serverPath?: string;
      message?: string;
    }): Promise<{
      ok: boolean;
      committed: boolean;
      sha?: string;
      pushed: boolean;
      nothingToCommit?: boolean;
      error?: string;
    }> => ipcRenderer.invoke("backup:commitPush", opts),
    listBackups: (opts: {
      accessToken?: string;
      workspaceId?: string;
    }): Promise<{ backups: { name: string; remoteUrl: string }[]; error?: string }> =>
      ipcRenderer.invoke("backup:listBackups", opts),
    restore: (opts: {
      remoteUrl: string;
      parentDir: string;
    }): Promise<{ ok: boolean; localPath?: string; error?: string }> =>
      ipcRenderer.invoke("backup:restore", opts),
    getAutoBackup: (): Promise<{ enabled: boolean }> => ipcRenderer.invoke("backup:getAutoBackup"),
    setAutoBackup: (enabled: boolean): Promise<{ ok: boolean; enabled: boolean }> =>
      ipcRenderer.invoke("backup:setAutoBackup", enabled),
  },

  // Files
  readFile: (filePath: string): Promise<string> => ipcRenderer.invoke("files:read", filePath),

  // Voice input → text (adb): transcribe recorded mic audio via OpenAI.
  transcribeAudio: (
    audioBase64: string,
    mimeType: string,
  ): Promise<{ text?: string; error?: string }> =>
    ipcRenderer.invoke("voice:transcribe", audioBase64, mimeType),
  writeFile: (filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke("files:write", filePath, content),
  undoGeneration: (manifestPath: string): Promise<void> =>
    ipcRenderer.invoke("files:undo", manifestPath),
  listManifests: (localPath: string): Promise<ManifestSummary[]> =>
    ipcRenderer.invoke("files:listManifests", localPath),
  addEnsure: (resourceName: string): Promise<void> =>
    ipcRenderer.invoke("files:addEnsure", resourceName),
  removeEnsure: (resourceName: string): Promise<void> =>
    ipcRenderer.invoke("files:removeEnsure", resourceName),
  isEnsured: (resourceName: string): Promise<boolean> =>
    ipcRenderer.invoke("files:isEnsured", resourceName),

  // Server status
  serverPing: (port: number): Promise<ServerPingResult> => ipcRenderer.invoke("server:ping", port),
  serverRestart: (
    resourceName: string,
    port: number,
    rconPassword: string,
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("server:restart", resourceName, port, rconPassword),

  // Deploy & smoke-test: ensure the resource + scan the console for load errors.
  smokeTestResource: (
    resourceName: string,
  ): Promise<import("../renderer/src/lib/types").SmokeResult> =>
    ipcRenderer.invoke("server:smokeTest", resourceName),
  smokeTestAll: (
    resourceNames: string[],
  ): Promise<import("../renderer/src/lib/types").SmokeAllResult> =>
    ipcRenderer.invoke("server:smokeTestAll", resourceNames),

  // Files — extended
  listResources: (localPath: string): Promise<string[]> =>
    ipcRenderer.invoke("files:listResources", localPath),
  deleteResource: (localPath: string, resourceName: string): Promise<void> =>
    ipcRenderer.invoke("files:deleteResource", localPath, resourceName),
  openInExplorer: (dirPath: string): Promise<void> =>
    ipcRenderer.invoke("files:openInExplorer", dirPath),

  // System-browser launch for the OAuth flow (z43-followup). Only http(s) URLs
  // are accepted by the main handler.
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("shell:openExternal", url),

  // Start Discord sign-in. Main runs a one-shot 127.0.0.1 loopback server and
  // returns its redirect URI; the renderer passes that to signInWithOAuth and
  // opens the authorize URL via openExternal. The OAuth code returns to the
  // loopback and arrives back via onAuthSignInCode below.
  startDiscordSignIn: (): Promise<string> => ipcRenderer.invoke("auth:start-signin"),

  // Persistent, encrypted (safeStorage) store backing the renderer's Supabase
  // Auth client — keeps the session + PKCE verifier across reload/refresh/relaunch.
  authStore: {
    get: (key: string): Promise<string | null> => ipcRenderer.invoke("auth:store:get", key),
    set: (key: string, value: string): Promise<void> =>
      ipcRenderer.invoke("auth:store:set", key, value),
    remove: (key: string): Promise<void> => ipcRenderer.invoke("auth:store:remove", key),
  },
  listDir: (
    dirPath: string,
  ): Promise<Array<{ name: string; relativePath: string; absolutePath: string }>> =>
    ipcRenderer.invoke("files:listDir", dirPath),
  checkServerProcess: (): Promise<{ running: boolean; pid?: number }> =>
    ipcRenderer.invoke("server:checkProcess"),
  startServer: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("server:start"),
  stopServer: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("server:stop"),
  testRcon: (port: number, rconPassword: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("server:testRcon", port, rconPassword),

  // txAdmin REST control — server restart button (zdy) + resource-manager live controls (myn)
  txadmin: {
    control: (
      action: "restart" | "stop" | "start",
    ): Promise<{ ok: boolean; message?: string; error?: string }> =>
      ipcRenderer.invoke("txadmin:control", action),
    command: (
      action: string,
      parameter?: string,
    ): Promise<{ ok: boolean; message?: string; error?: string }> =>
      ipcRenderer.invoke("txadmin:command", action, parameter),
    testConnection: (): Promise<{ ok: boolean; name?: string; error?: string }> =>
      ipcRenderer.invoke("txadmin:testConnection"),
    isAvailable: (): Promise<{ available: boolean }> => ipcRenderer.invoke("txadmin:isAvailable"),
    // Zero-password login (dt2): open the txAdmin panel, harvest the session.
    webviewLogin: (): Promise<{
      ok: boolean;
      name?: string;
      error?: string;
      cancelled?: boolean;
    }> => ipcRenderer.invoke("txadmin:webviewLogin"),
    webviewLogout: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("txadmin:webviewLogout"),
    hasWebviewSession: (): Promise<{ active: boolean }> =>
      ipcRenderer.invoke("txadmin:hasWebviewSession"),
  },

  // Server console stream — returns a cleanup function
  onServerConsole: (callback: (entry: ConsoleEntry) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: ConsoleEntry): void => {
      try {
        callback(entry);
      } catch (err) {
        console.error("[preload] console callback error:", err);
      }
    };
    ipcRenderer.on("stream:serverConsole", handler);
    return () => ipcRenderer.removeListener("stream:serverConsole", handler);
  },

  // Get buffered console entries (for initial load)
  getConsoleBuffer: (): Promise<ConsoleEntry[]> => ipcRenderer.invoke("fxdk:getConsoleBuffer"),

  // Get FxDK session state
  getSessionState: (): Promise<string> => ipcRenderer.invoke("fxdk:getSessionState"),

  // GameView — frame capture
  gameviewStart: (options?: GameViewStartOptions): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("gameview:start", options),
  gameviewStop: (): Promise<void> => ipcRenderer.invoke("gameview:stop"),
  gameviewStats: (): Promise<GameViewStats> => ipcRenderer.invoke("gameview:stats"),
  gameviewCapabilities: (): Promise<GameViewCapabilities> =>
    ipcRenderer.invoke("gameview:capabilities"),
  // Orchestrator — FxDK game client lifecycle
  orchestratorStart: (config: OrchestratorConfig): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("orchestrator:startGame", config),
  orchestratorStop: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("orchestrator:stopGame"),
  orchestratorGetState: (): Promise<OrchestratorState> =>
    ipcRenderer.invoke("orchestrator:getState"),
  onOrchestratorState: (callback: (state: OrchestratorState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: OrchestratorState): void => {
      try {
        callback(state);
      } catch (err) {
        console.error("[preload] orchestratorState callback error:", err);
      }
    };
    ipcRenderer.on("stream:orchestratorState", handler);
    return () => ipcRenderer.removeListener("stream:orchestratorState", handler);
  },

  onOrchestratorLog: (callback: (entry: OrchestratorLogEntry) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: OrchestratorLogEntry): void => {
      try {
        callback(entry);
      } catch (err) {
        console.error("[preload] orchestratorLog callback error:", err);
      }
    };
    ipcRenderer.on("stream:orchestratorLog", handler);
    return () => ipcRenderer.removeListener("stream:orchestratorLog", handler);
  },

  // OAuth code delivery. After Discord completes in the system browser, Supabase
  // redirects to the main process's loopback server with ?code=…; main forwards
  // it here so CustomAuth can finish via exchangeCodeForSession(). Returns a
  // cleanup fn.
  onAuthSignInCode: (callback: (code: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, code: string): void => {
      try {
        callback(code);
      } catch (err) {
        console.error("[preload] auth signin-code handler error:", err);
      }
    };
    ipcRenderer.on("auth:signin-code", handler);
    return () => ipcRenderer.removeListener("auth:signin-code", handler);
  },

  onGameFrame: (callback: (frame: GameFrameMessage) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, frame: GameFrameMessage): void => {
      try {
        callback(frame);
      } catch (err) {
        console.error("[preload] gameFrame callback error:", err);
      }
    };
    ipcRenderer.on("stream:gameFrame", handler);
    return () => ipcRenderer.removeListener("stream:gameFrame", handler);
  },
};

// contextIsolation is always ON in this app, so ALWAYS bridge via contextBridge.
// The previous `if (process.contextIsolated)` guard is unreliable under
// sandbox:true — the sandboxed preload's `process` polyfill leaves
// `contextIsolated` undefined, which sent us down the (contextIsolation-off)
// `window.api = ...` path that can't cross the isolation boundary, leaving
// window.api undefined in the renderer (fivem-studio-c0x).
try {
  contextBridge.exposeInMainWorld("api", api);
} catch (error) {
  console.error("[preload] contextBridge expose failed:", error);
}
