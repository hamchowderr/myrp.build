/// <reference types="vite/client" />

interface Window {
  electron: import("@electron-toolkit/preload").ElectronAPI;
  api: {
    isDevBypass: boolean;
    selectFolder: () => Promise<string | null>;
    selectFile: () => Promise<string | null>;
    saveSettings: (
      settings: import("./lib/types").AppSettings,
    ) => Promise<void>;
    loadSettings: () => Promise<import("./lib/types").AppSettings | null>;
    scaffoldServer: (
      parentDir: string,
      name: string,
    ) => Promise<import("./lib/types").ScaffoldResult | { error: string }>;
    findServerPaths: () => Promise<string[]>;
    findServerExe: (serverPath: string) => Promise<string | null>;
    detectContext: (
      serverPath: string,
    ) => Promise<import("./lib/types").ServerContext>;
    chat: {
      start: (payload: {
        text: string;
        chatId: string;
        model?: string;
        accessToken?: string;
        workspaceId?: string;
      }) => Promise<void>;
      cancel: () => Promise<void>;
      approve: (approved: boolean) => Promise<void>;
      clone: (payload: {
        sourceThreadId: string;
        newThreadId: string;
        accessToken?: string;
        workspaceId?: string;
      }) => Promise<{ ok: boolean; copied?: number; error?: string }>;
      listThreads: (payload: {
        accessToken?: string;
        workspaceId?: string;
      }) => Promise<{
        ok: boolean;
        threads?: {
          id: string;
          title: string | null;
          updatedAt: string;
          archivedAt: string | null;
        }[];
        error?: string;
      }>;
      searchThreads: (payload: {
        query: string;
        accessToken?: string;
        workspaceId?: string;
      }) => Promise<{
        ok: boolean;
        results?: {
          id: string;
          title: string | null;
          snippet: string | null;
          updatedAt: string;
          archivedAt: string | null;
        }[];
        error?: string;
      }>;
      setThreadArchived: (payload: {
        threadId: string;
        archived: boolean;
        accessToken?: string;
        workspaceId?: string;
      }) => Promise<{ ok: boolean; error?: string }>;
      loadThread: (payload: {
        threadId: string;
        accessToken?: string;
        workspaceId?: string;
      }) => Promise<{ ok: boolean; messages?: unknown[]; error?: string }>;
      renameThread: (payload: {
        threadId: string;
        title: string;
        accessToken?: string;
        workspaceId?: string;
      }) => Promise<{ ok: boolean; error?: string }>;
      deleteThread: (payload: {
        threadId: string;
        accessToken?: string;
        workspaceId?: string;
      }) => Promise<{ ok: boolean; error?: string }>;
      suggestFollowups: (payload: {
        threadId: string;
        accessToken?: string;
        workspaceId?: string;
      }) => Promise<{ ok: boolean; suggestions?: string[]; error?: string }>;
      onApprovalPending: (callback: () => void) => () => void;
      onChunk: (callback: (chunk: unknown) => void) => () => void;
      onDone: (
        callback: (payload: { generationId: string | null }) => void,
      ) => () => void;
      onError: (callback: (message: string) => void) => () => void;
      onResult: (
        callback: (result: import("./lib/types").GenerationResult) => void,
      ) => () => void;
    };
    feedback: {
      rate: (generationId: string, rating: "up" | "down") => Promise<boolean>;
    };
    backup: {
      gitInit: (serverPath?: string) => Promise<{
        ok: boolean;
        alreadyRepo: boolean;
        gitignoreWritten: boolean;
        secretWarnings: { line: number; directive: string }[];
        error?: string;
      }>;
      githubStatus: () => Promise<{ connected: boolean; login?: string }>;
      githubConnect: (
        token: string,
      ) => Promise<{ ok: boolean; login?: string; error?: string }>;
      githubDisconnect: () => Promise<{ ok: boolean }>;
      linkRepo: (opts: {
        serverPath?: string;
        repoName?: string;
        isPrivate?: boolean;
        org?: string;
        accessToken?: string;
        workspaceId?: string;
      }) => Promise<{
        ok: boolean;
        repoUrl?: string;
        htmlUrl?: string;
        fullName?: string;
        isPrivate?: boolean;
        cloudSynced?: boolean;
        secretWarnings?: { line: number; directive: string }[];
        error?: string;
      }>;
      repoStatus: (serverPath?: string) => Promise<{ linked: boolean; remoteUrl?: string }>;
      commitPush: (opts: { serverPath?: string; message?: string }) => Promise<{
        ok: boolean;
        committed: boolean;
        sha?: string;
        pushed: boolean;
        nothingToCommit?: boolean;
        error?: string;
      }>;
      listBackups: (opts: {
        accessToken?: string;
        workspaceId?: string;
      }) => Promise<{ backups: { name: string; remoteUrl: string }[]; error?: string }>;
      restore: (opts: {
        remoteUrl: string;
        parentDir: string;
      }) => Promise<{ ok: boolean; localPath?: string; error?: string }>;
      getAutoBackup: () => Promise<{ enabled: boolean }>;
      setAutoBackup: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean }>;
    };
    readFile: (filePath: string) => Promise<string>;
    transcribeAudio: (
      audioBase64: string,
      mimeType: string,
    ) => Promise<{ text?: string; error?: string }>;
    writeFile: (filePath: string, content: string) => Promise<void>;
    undoGeneration: (manifestPath: string) => Promise<void>;
    listManifests: (
      localPath: string,
    ) => Promise<import("./lib/types").ManifestSummary[]>;
    addEnsure: (resourceName: string) => Promise<void>;
    removeEnsure: (resourceName: string) => Promise<void>;
    isEnsured: (resourceName: string) => Promise<boolean>;
    serverPing: (
      port: number,
    ) => Promise<import("./lib/types").ServerPingResult>;
    serverRestart: (
      resourceName: string,
      port: number,
      rconPassword: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    smokeTestResource: (
      resourceName: string,
    ) => Promise<import("./lib/types").SmokeResult>;
    smokeTestAll: (
      resourceNames: string[],
    ) => Promise<import("./lib/types").SmokeAllResult>;
    openInExplorer: (dirPath: string) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
    startDiscordSignIn: () => Promise<string>;
    authStore: {
      get: (key: string) => Promise<string | null>;
      set: (key: string, value: string) => Promise<void>;
      remove: (key: string) => Promise<void>;
    };
    listResources: (localPath: string) => Promise<string[]>;
    deleteResource: (localPath: string, resourceName: string) => Promise<void>;
    listDir: (
      dirPath: string,
    ) => Promise<
      Array<{ name: string; relativePath: string; absolutePath: string }>
    >;
    checkServerProcess: () => Promise<{ running: boolean; pid?: number }>;
    startServer: () => Promise<{ ok: boolean; error?: string }>;
    stopServer: () => Promise<{ ok: boolean; error?: string }>;
    testRcon: (
      port: number,
      rconPassword: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    txadmin: {
      control: (
        action: "restart" | "stop" | "start",
      ) => Promise<{ ok: boolean; message?: string; error?: string }>;
      command: (
        action: string,
        parameter?: string,
      ) => Promise<{ ok: boolean; message?: string; error?: string }>;
      testConnection: () => Promise<{ ok: boolean; name?: string; error?: string }>;
      isAvailable: () => Promise<{ available: boolean }>;
      webviewLogin: () => Promise<{
        ok: boolean;
        name?: string;
        error?: string;
        cancelled?: boolean;
      }>;
      webviewLogout: () => Promise<{ ok: boolean }>;
      hasWebviewSession: () => Promise<{ active: boolean }>;
    };
    onServerConsole: (
      callback: (entry: import("./lib/types").ConsoleEntry) => void,
    ) => () => void;
    getConsoleBuffer: () => Promise<import("./lib/types").ConsoleEntry[]>;
    getSessionState: () => Promise<string>;
    gameviewStart: (
      options?: import("./lib/types").GameViewStartOptions,
    ) => Promise<{ ok: boolean; error?: string }>;
    gameviewStop: () => Promise<void>;
    gameviewStats: () => Promise<import("./lib/types").GameViewStats>;
    gameviewCapabilities: () => Promise<
      import("./lib/types").GameViewCapabilities
    >;
    onAuthSignInCode: (callback: (code: string) => void) => () => void;
    onGameFrame: (
      callback: (frame: import("./lib/types").GameFrameMessage) => void,
    ) => () => void;
    orchestratorStart: (
      config: import("./lib/types").OrchestratorConfig,
    ) => Promise<{ ok: boolean; error?: string }>;
    orchestratorStop: () => Promise<{ ok: boolean; error?: string }>;
    orchestratorGetState: () => Promise<
      import("./lib/types").OrchestratorState
    >;
    onOrchestratorState: (
      callback: (state: import("./lib/types").OrchestratorState) => void,
    ) => () => void;
    onOrchestratorLog: (
      callback: (entry: import("./lib/types").OrchestratorLogEntry) => void,
    ) => () => void;
  };
}
