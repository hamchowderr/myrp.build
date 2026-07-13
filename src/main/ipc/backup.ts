/**
 * IPC for server backup to GitHub. git-init + .gitignore is
 * the foundation; connect-remote + repo link and commit/push build on it.
 *
 * GitHub auth is the SAME Supabase OAuth used for sign-in: the renderer links a
 * GitHub identity (supabase.auth.linkIdentity, `repo` scope) and hands main the
 * resulting provider_token, which main stores in safeStorage (NEVER the database)
 * and uses to create/link ONE repo per server. The clean repo URL is shared
 * across the workspace via the cloud `servers` row (set_server_github_remote);
 * team members get access through GitHub-native collaborator invites.
 */
import { createHash } from "node:crypto";
import { ipcMain } from "electron";
import log from "electron-log/main";
import { getActiveServer } from "../../renderer/src/lib/server-registry";
import { getStoredSecret, removeStoredSecret, setStoredSecret } from "../bootstrap/auth";
import { createRunClient } from "../mastra/storage/supabase-client";
import {
  autoBackupEligible,
  cloneServerRepo,
  commitAndPushServer,
  deriveRepoName,
  ensureGithubRepo,
  getGithubLogin,
  getGitRemoteUrl,
  gitInitServer,
  setGitRemote,
} from "../server-backup";
import { readSettings } from "../shared-state";

// Keys in the encrypted auth-store.bin (shared with the Supabase session).
const TOKEN_KEY = "github_provider_token";
const LOGIN_KEY = "github_login";
// Auto-backup toggle lives here (NOT settings.json) — settings.json gets fully
// rewritten by various saveSettings() callers from their own in-memory snapshot,
// which clobbered a flag set elsewhere. A dedicated key is immune to that.
const AUTO_KEY = "auto_backup_enabled";

/** sha256(serverPath) → the stable client_server_key the cloud `servers` row uses
 *  (mirrors ipc/chat.ts so the github remote attaches to the SAME server row). */
function clientServerKey(serverPath: string): string {
  return createHash("sha256").update(serverPath).digest("hex").slice(0, 32);
}

// ── Auto-backup ──────────────────────────────────────────
// Opt-in: when settings.autoBackup is on, a successful generation schedules a
// debounced commit+push of the active server. Debounce coalesces bursty
// generations into one push; commitAndPushServer is idempotent (clean tree =>
// no-op) so it self-limits. Failures are logged, never surfaced — auto-backup
// must never interrupt the user.
const AUTO_DEBOUNCE_MS = 30_000;
let autoTimer: ReturnType<typeof setTimeout> | undefined;
let autoRunning = false;

async function runAutoBackup(): Promise<void> {
  if (autoRunning) return;
  autoRunning = true;
  try {
    const settings = await readSettings();
    const serverPath = settings ? getActiveServer(settings)?.serverPath : undefined;
    const token = getStoredSecret(TOKEN_KEY);
    const login = getStoredSecret(LOGIN_KEY);
    const remoteUrl = serverPath ? await getGitRemoteUrl(serverPath) : null;
    const enabled = getStoredSecret(AUTO_KEY) === "1";
    if (!autoBackupEligible({ enabled, serverPath, token, login, remoteUrl })) {
      return;
    }
    const res = await commitAndPushServer(serverPath as string, {
      token: token as string,
      login: login as string,
      remoteUrl: remoteUrl as string,
      message: `myRP.build auto-backup ${new Date().toISOString()}`,
    });
    if (res.ok) log.info("[auto-backup]", res.nothingToCommit ? "up to date" : `pushed ${res.sha}`);
    else log.warn("[auto-backup] failed:", res.error);
  } catch (err) {
    log.warn("[auto-backup] error:", err instanceof Error ? err.message : String(err));
  } finally {
    autoRunning = false;
  }
}

/** Schedule a debounced auto-backup (called after a successful generation). */
export function scheduleAutoBackup(): void {
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = undefined;
    void runAutoBackup();
  }, AUTO_DEBOUNCE_MS);
}

export function registerBackupHandlers(): void {
  // Init a server folder as a git repo + write a FiveM .gitignore. Defaults to the
  // active server when no path is given; flags likely secrets in server.cfg.
  ipcMain.handle("backup:gitInit", async (_event, serverPath?: string) => {
    const target = serverPath ?? getActiveServer(await readSettings())?.serverPath;
    if (!target) {
      return {
        ok: false,
        alreadyRepo: false,
        gitignoreWritten: false,
        secretWarnings: [],
        error: "No active server is configured.",
      };
    }
    return gitInitServer(target);
  });

  // Is a GitHub account connected? Returns the cached login (no network round-trip).
  ipcMain.handle("backup:githubStatus", async () => {
    const token = getStoredSecret(TOKEN_KEY);
    return { connected: !!token, login: getStoredSecret(LOGIN_KEY) ?? undefined };
  });

  // Store + verify a GitHub provider_token captured by the renderer's
  // linkIdentity → exchangeCodeForSession. Verifying also resolves the login.
  ipcMain.handle("backup:githubConnect", async (_event, token: string) => {
    if (!token || typeof token !== "string") {
      return { ok: false, error: "No GitHub token was provided." };
    }
    try {
      const login = await getGithubLogin(token);
      setStoredSecret(TOKEN_KEY, token);
      setStoredSecret(LOGIN_KEY, login);
      log.info("[backup] GitHub connected as", login);
      return { ok: true, login };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("backup:githubDisconnect", async () => {
    removeStoredSecret(TOKEN_KEY);
    removeStoredSecret(LOGIN_KEY);
    return { ok: true };
  });

  // Auto-backup toggle — persisted in the dedicated store, not settings.json.
  ipcMain.handle("backup:getAutoBackup", async () => ({
    enabled: getStoredSecret(AUTO_KEY) === "1",
  }));
  ipcMain.handle("backup:setAutoBackup", async (_event, enabled: boolean) => {
    if (enabled) setStoredSecret(AUTO_KEY, "1");
    else removeStoredSecret(AUTO_KEY);
    return { ok: true, enabled: !!enabled };
  });

  // Create-or-link a repo for a server and point its `origin` at it. Persists the
  // clean repo URL on the cloud `servers` row (shared across the workspace) when a
  // JWT + workspace are supplied; a cloud failure is non-fatal (local remote still
  // works). The repo is git-init'd first if needed.
  ipcMain.handle(
    "backup:linkRepo",
    async (
      _event,
      opts: {
        serverPath?: string;
        repoName?: string;
        isPrivate?: boolean;
        org?: string;
        accessToken?: string;
        workspaceId?: string;
      },
    ) => {
      const target = opts.serverPath ?? getActiveServer(await readSettings())?.serverPath;
      if (!target) return { ok: false, error: "No active server is configured." };

      const token = getStoredSecret(TOKEN_KEY);
      const owner = getStoredSecret(LOGIN_KEY);
      if (!token || !owner) return { ok: false, error: "Connect GitHub first." };

      try {
        // Foundation: ensure the folder is a repo with a .gitignore before wiring a
        // remote (idempotent; surfaces secret warnings the caller can show).
        const init = await gitInitServer(target);
        if (!init.ok) return { ok: false, error: init.error ?? "git init failed." };

        const repo = await ensureGithubRepo(token, {
          name: opts.repoName?.trim() || deriveRepoName(target),
          owner,
          isPrivate: opts.isPrivate ?? true,
          org: opts.org?.trim() || undefined,
        });
        await setGitRemote(target, repo.cloneUrl);

        // Share the remote URL across the workspace (cloud `servers` row). Best
        // effort: the local remote is already set even if this fails.
        let cloudSynced = false;
        if (opts.accessToken && opts.workspaceId) {
          const client = createRunClient(opts.accessToken);
          if (client) {
            const { error } = await client.rpc("set_server_github_remote", {
              p_workspace_id: opts.workspaceId,
              p_client_server_key: clientServerKey(target),
              p_github_remote_url: repo.cloneUrl,
            });
            if (error) log.warn("[backup] set_server_github_remote failed:", error.message);
            else cloudSynced = true;
          }
        }

        return {
          ok: true,
          repoUrl: repo.cloneUrl,
          htmlUrl: repo.htmlUrl,
          fullName: repo.fullName,
          isPrivate: repo.isPrivate,
          cloudSynced,
          secretWarnings: init.secretWarnings,
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // Is a backup repo linked for this server? (origin set). Lets the UI show
  // "Back up now" after a reload without re-running the link flow.
  ipcMain.handle("backup:repoStatus", async (_event, serverPath?: string) => {
    const target = serverPath ?? getActiveServer(await readSettings())?.serverPath;
    if (!target) return { linked: false };
    const remoteUrl = await getGitRemoteUrl(target);
    return { linked: !!remoteUrl, remoteUrl: remoteUrl ?? undefined };
  });

  // Back up now: commit the server folder + push to its GitHub repo. The
  // token is read from safeStorage and injected only at push time.
  ipcMain.handle(
    "backup:commitPush",
    async (_event, opts: { serverPath?: string; message?: string }) => {
      const target = opts.serverPath ?? getActiveServer(await readSettings())?.serverPath;
      if (!target) {
        return {
          ok: false,
          committed: false,
          pushed: false,
          error: "No active server is configured.",
        };
      }
      const token = getStoredSecret(TOKEN_KEY);
      const login = getStoredSecret(LOGIN_KEY);
      if (!token || !login) {
        return { ok: false, committed: false, pushed: false, error: "Connect GitHub first." };
      }
      const remoteUrl = await getGitRemoteUrl(target);
      if (!remoteUrl) {
        return {
          ok: false,
          committed: false,
          pushed: false,
          error: "No backup repo is linked for this server.",
        };
      }
      return commitAndPushServer(target, { token, login, remoteUrl, message: opts.message });
    },
  );

  // List this workspace's backed-up servers (cloud `servers` rows with a remote)
  // so the user can pick one to restore. RLS-scoped read via the per-run JWT.
  ipcMain.handle(
    "backup:listBackups",
    async (_event, opts: { accessToken?: string; workspaceId?: string }) => {
      if (!opts.accessToken || !opts.workspaceId) return { backups: [] };
      const client = createRunClient(opts.accessToken);
      if (!client) return { backups: [] };
      const { data, error } = await client
        .from("servers")
        .select("name, github_remote_url")
        .eq("workspace_id", opts.workspaceId)
        .not("github_remote_url", "is", null);
      if (error) return { backups: [], error: error.message };
      const backups = (data ?? [])
        .filter(
          (r): r is { name: string | null; github_remote_url: string } => !!r.github_remote_url,
        )
        .map((r) => ({ name: r.name ?? r.github_remote_url, remoteUrl: r.github_remote_url }));
      return { backups };
    },
  );

  // Restore (clone) a server repo into parentDir/<repoName>. Token from
  // safeStorage authenticates the clone, then origin is reset to the clean url.
  ipcMain.handle(
    "backup:restore",
    async (_event, opts: { remoteUrl: string; parentDir: string }) => {
      const token = getStoredSecret(TOKEN_KEY);
      if (!token) return { ok: false, error: "Connect GitHub first." };
      if (!opts.remoteUrl?.trim() || !opts.parentDir?.trim()) {
        return { ok: false, error: "Pick a repository and a destination folder." };
      }
      return cloneServerRepo({
        token,
        remoteUrl: opts.remoteUrl.trim(),
        parentDir: opts.parentDir.trim(),
      });
    },
  );
}
