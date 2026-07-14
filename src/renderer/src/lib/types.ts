/**
 * One registered FiveM server. The local registry (AppSettings.servers) is the
 * SINGLE source of truth for per-server connection config — these are all
 * machine-local (file paths, 127.0.0.1 URLs, secrets) and are NEVER mirrored to
 * the cloud `servers` table (which holds only memory-scoping identity).
 * Derived data (framework/db/inventory from server.cfg, run
 * status from txAdmin) is read live at display time, not stored here.
 */
export interface ServerRecord {
  id: string; // stable local uuid (registry key)
  name: string; // friendly label, derived from the server path by default
  serverPath: string;
  localPath: string; // path to resources/[local]/ inside the server
  serverPort?: number; // FiveM server HTTP port, default 30120
  rconPassword?: string; // rcon_password override; falls back to server.cfg parse
  serverExePath?: string; // absolute path to FXServer.exe
  fivemExePath?: string; // absolute path to FiveM.exe game client
  // txAdmin REST control (server restart button + resource-manager live controls).
  // Same fields work for local (127.0.0.1:40120) and cloud txAdmin.
  txAdminUrl?: string; // txAdmin web base URL, default http://127.0.0.1:40120
  txAdminUsername?: string; // txAdmin admin username
  txAdminPassword?: string; // txAdmin backup password (numeric)
  lastOpenedAt?: number; // epoch ms the server was last opened/selected (dashboard "last activity")
}

export interface AppSettings {
  servers: ServerRecord[]; // the registry — per-server connection config
  activeServerId: string | null; // which registered server is currently selected
  apiKey?: never; // never stored in settings — always from .env
  requireApproval?: boolean; // app-level: gate sensitive ops (shell/delete) behind approve/decline
  useHarness?: boolean; // alpha: route chat through the Mastra Harness instead of agent.stream. Default-OFF; env MYRP_USE_HARNESS=1 also enables it for dev.
}

export interface ServerPingResult {
  online: boolean;
  hostname?: string;
}

/** Result of scaffolding a fresh ox server folder. */
export interface ScaffoldResult {
  serverPath: string;
  serverCfgPath: string;
  installed: string[]; // ox base resources that downloaded successfully
  failed: string[]; // ox base resources that failed to download (add later)
}

export interface ServerContext {
  framework: "ox_core" | "esx" | "qbcore" | "qbox" | "unknown";
  dbDriver: "oxmysql" | "mysql-async" | "unknown";
  inventory: "ox_inventory" | "qb-inventory" | "unknown";
  gameBuild: string;
  existingResources: string[];
  serverCfgPath: string;
}

// ---- Generation ----

export interface WrittenFile {
  /** Absolute path on disk */
  absolutePath: string;
  /** Relative path inside the resource folder (e.g. "client/main.lua") */
  relativePath: string;
}

export interface GenerationResult {
  resourceName: string;
  /** Absolute path to the resource directory */
  resourceDir: string;
  /** Files written by the agent */
  files: WrittenFile[];
  /** Absolute path to the generation manifest used for undo */
  manifestPath: string;
}

// ---- IPC stream messages (main → renderer) ----

export type ToolStatus = "running" | "done" | "error";

export interface ToolLogEntry {
  id: string;
  tool: string;
  /** File path if relevant */
  path?: string;
  status: ToolStatus;
}

export interface ValidationIssue {
  file: string;
  line?: number;
  issue: string;
}

export interface ValidationResult {
  valid: boolean;
  critical: ValidationIssue[];
  warnings: ValidationIssue[];
  summary: string;
}

export type StreamMessage =
  | { type: "status"; text: string }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; tool: string; path?: string }
  | { type: "tool_done"; id: string; success: boolean }
  | { type: "error"; text: string }
  | { type: "complete"; result: GenerationResult | null }
  | { type: "validation_result"; data: ValidationResult }
  | { type: "collision_warning"; existingName: string; suggestedName: string }
  | { type: "agent_started"; agentId: string; agentName: string; role: string }
  | {
      type: "agent_progress";
      agentId: string;
      summary: string;
      toolName?: string;
    }
  | {
      type: "agent_completed";
      agentId: string;
      summary: string;
      stats?: { tools: number; duration: number };
    }
  | { type: "session_id"; sessionId: string }
  | { type: "queued"; position: number }
  | { type: "token_info"; inputTokens: number; thinking: string }
  | { type: "citations"; sources: string[] }
  | {
      type: "batch_progress";
      batchId: string;
      status: string;
      total: number;
      succeeded: number;
      errored: number;
    }
  | {
      type: "batch_complete";
      batchId: string;
      results: Array<{
        customId: string;
        status: string;
        text?: string;
        error?: string;
      }>;
    }
  | {
      type: "memory_loaded";
      conventionCount: number;
      patternCount: number;
      errorCount: number;
    };

// ---- Server Console ----

export interface ConsoleEntry {
  id: string;
  source: "stdout" | "stderr" | "system";
  /** ANSI-stripped plain text (back-compat: existing readers stay clean). */
  text: string;
  /** Original line WITH ANSI/FiveM color codes intact, for the ANSI terminal. */
  raw?: string;
  timestamp: number;
}

// ---- Deploy smoke-test ----

/** Result of deploying a resource to the FXServer and scanning the console. */
export interface SmokeResult {
  /** Overall: deployed AND no load errors detected. */
  ok: boolean;
  deployed: boolean;
  loadSuccess: boolean;
  startedConfirmed: boolean;
  loadError?: string;
  matchedPattern?: string;
  consoleSnippet?: string[];
  secondsWaited: number;
}

/** One resource's row in a full (all-resources) deploy + smoke test. */
export interface SmokeResourceResult extends SmokeResult {
  resource: string;
}

/** Result of deploying + smoke-testing every built resource at once. */
export interface SmokeAllResult {
  ok: boolean;
  results: SmokeResourceResult[];
}

export interface ManifestSummary {
  resourceName: string;
  resourceDir: string;
  fileCount: number;
  createdAt: string;
  manifestPath: string;
}

// ---- Prompt History ----

export interface PromptHistoryEntry {
  id: string;
  prompt: string;
  timestamp: string; // ISO
  resourceName?: string;
}

export type AppScreen = "setup" | "dashboard" | "generator" | "settings" | "resources" | "deploy";

// ---- V2 Layout ----

// ---- GameView ----

export interface GameFrameMessage {
  jpeg: string;
  width: number;
  height: number;
  timestamp: number;
  fps: number;
  backend: "cpu" | "gpu" | "test" | "none";
}

export interface GameViewStartOptions {
  width?: number;
  height?: number;
  targetFps?: number;
  testMode?: boolean;
}

export interface GameViewCapabilities {
  gpuAvailable: boolean;
  cpuAvailable: boolean;
  reason?: string;
}

export interface GameViewStats {
  fps: number;
  backend: string;
  droppedFrames: number;
}

// ---- FxDK Orchestrator ----

export type OrchestratorState =
  | "idle"
  | "initializing"
  | "launching"
  | "waitingForGame"
  | "running"
  | "stopping"
  | "error";

export interface OrchestratorConfig {
  fivemExePath: string;
  serverAddress?: string;
  width?: number;
  height?: number;
  fpsLimit?: number;
  surfaceLimit?: number;
  initTimeoutMs?: number;
}

export interface OrchestratorLogEntry {
  level: "info" | "warn" | "error";
  message: string;
  timestamp: number;
}
