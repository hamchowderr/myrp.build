/**
 * Server registry helpers (fivem-studio-m8se.1).
 *
 * AppSettings.servers is the SINGLE on-disk source of truth for per-server
 * connection config. These pure helpers are shared by the main process (disk
 * read/write, IPC consumers) and the renderer (Settings UI, server switcher).
 *
 * No field is ever stored twice: the cloud `servers` table holds only
 * memory-scoping identity (keyed by hash(serverPath)); derived data
 * (framework/db from server.cfg, run status from txAdmin) is read live at use
 * time. Nothing here persists a copy of either.
 */

import type { AppSettings, ServerRecord } from "./types";

/** Stable id for a newly registered server. */
export function newServerId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Friendly name from a server path — e.g. a txData folder name with its hash
 * suffix stripped, camelCase/underscores turned into spaces.
 */
export function deriveServerName(serverPath: string): string {
  const parts = serverPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const folder = parts[parts.length - 1] || parts[parts.length - 2] || serverPath;
  const cleaned = folder.replace(/_[A-F0-9]{6}\.base$/i, "").replace(/\.base$/i, "");
  return (
    cleaned
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]/g, " ")
      .trim() || folder
  );
}

/** The currently selected server, or the first registered one as a fallback, or null. */
export function getActiveServer(settings: AppSettings): ServerRecord | null {
  if (!settings.servers?.length) return null;
  return settings.servers.find((s) => s.id === settings.activeServerId) ?? settings.servers[0];
}

/** Like getActiveServer but throws when no server is registered (main-process call sites). */
export function requireActiveServer(settings: AppSettings): ServerRecord {
  const active = getActiveServer(settings);
  if (!active) throw new Error("No active server is configured.");
  return active;
}

/** Default localPath for a server folder. */
export function defaultLocalPath(serverPath: string): string {
  return `${serverPath}/resources/[local]`;
}

/** An empty registry (no servers registered yet). */
export function emptySettings(): AppSettings {
  return { servers: [], activeServerId: null };
}

/**
 * Normalize loaded settings into registry shape. Accepts:
 *  - already-migrated registry settings (passed through, active id repaired),
 *  - legacy flat settings (single server promoted to one record),
 *  - null/garbage (empty registry).
 * Idempotent — safe to run on every load.
 */
export function migrateSettings(raw: unknown): AppSettings {
  const s = (raw ?? {}) as Record<string, unknown> & Partial<AppSettings>;

  // Already migrated: keep records, repair active id, preserve app-level flags.
  if (Array.isArray(s.servers)) {
    const servers = s.servers as ServerRecord[];
    const activeServerId =
      servers.find((r) => r.id === s.activeServerId)?.id ?? servers[0]?.id ?? null;
    return { servers, activeServerId, requireApproval: s.requireApproval };
  }

  // Legacy flat settings (pre-registry) → one record.
  const legacy = s as {
    serverPath?: string;
    localPath?: string;
    serverPort?: number;
    rconPassword?: string;
    serverExePath?: string;
    fivemExePath?: string;
    txAdminUrl?: string;
    txAdminUsername?: string;
    txAdminPassword?: string;
    requireApproval?: boolean;
  };
  if (legacy.serverPath) {
    const record: ServerRecord = {
      id: newServerId(),
      name: deriveServerName(legacy.serverPath),
      serverPath: legacy.serverPath,
      localPath: legacy.localPath ?? defaultLocalPath(legacy.serverPath),
      serverPort: legacy.serverPort,
      rconPassword: legacy.rconPassword,
      serverExePath: legacy.serverExePath,
      fivemExePath: legacy.fivemExePath,
      txAdminUrl: legacy.txAdminUrl,
      txAdminUsername: legacy.txAdminUsername,
      txAdminPassword: legacy.txAdminPassword,
    };
    return {
      servers: [record],
      activeServerId: record.id,
      requireApproval: legacy.requireApproval,
    };
  }

  return { ...emptySettings(), requireApproval: legacy.requireApproval };
}

/** Immutably patch the active server record. No-op if no server is active. */
export function upsertActiveServer(
  settings: AppSettings,
  patch: Partial<Omit<ServerRecord, "id">>,
): AppSettings {
  const active = getActiveServer(settings);
  if (!active) return settings;
  return {
    ...settings,
    servers: settings.servers.map((s) => (s.id === active.id ? { ...s, ...patch } : s)),
  };
}

/** Select an already-registered server as active. */
export function setActiveServer(settings: AppSettings, id: string): AppSettings {
  return { ...settings, activeServerId: id };
}

/**
 * Rename a registered server (the display name only — its path/config are
 * untouched). Trims + caps the name; a blank name is ignored. No-op if the id
 * isn't registered.
 */
export function renameServer(settings: AppSettings, id: string, name: string): AppSettings {
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed) return settings;
  return {
    ...settings,
    servers: settings.servers.map((s) => (s.id === id ? { ...s, name: trimmed } : s)),
  };
}

/**
 * Select a server as active AND stamp its lastOpenedAt (dashboard "last
 * activity"). `now` is passed in so this stays pure/testable. No-op if the id
 * isn't registered.
 */
export function markOpened(settings: AppSettings, id: string, now: number): AppSettings {
  if (!settings.servers.some((s) => s.id === id)) return settings;
  return {
    ...settings,
    activeServerId: id,
    servers: settings.servers.map((s) => (s.id === id ? { ...s, lastOpenedAt: now } : s)),
  };
}

/**
 * Register a server folder (or re-select it if its path is already registered)
 * and make it active. Returns the updated settings plus the resolved record.
 * Switching servers this way NEVER clobbers other servers' config.
 */
export function addServer(
  settings: AppSettings,
  serverPath: string,
  opts?: { serverExePath?: string; name?: string },
): { settings: AppSettings; record: ServerRecord } {
  const existing = settings.servers.find((s) => s.serverPath === serverPath);
  if (existing) {
    return { settings: setActiveServer(settings, existing.id), record: existing };
  }
  const record: ServerRecord = {
    id: newServerId(),
    name: opts?.name ?? deriveServerName(serverPath),
    serverPath,
    localPath: defaultLocalPath(serverPath),
    ...(opts?.serverExePath ? { serverExePath: opts.serverExePath } : {}),
  };
  return {
    settings: { ...settings, servers: [...settings.servers, record], activeServerId: record.id },
    record,
  };
}
