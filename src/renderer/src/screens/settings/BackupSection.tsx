/**
 * Backup → GitHub settings section (fivem-studio-1yef.2).
 *
 * Two steps: (1) connect a GitHub account — the SAME Supabase OAuth used for
 * sign-in, via linkIdentity({ provider:'github', scopes:'repo' }) through the RFC
 * 8252 loopback; the resulting provider_token is handed to main (safeStorage,
 * never the DB). (2) Create/link ONE repo for the active server and point its
 * `origin` at it; the clean URL is shared across the workspace so teammates (added
 * as GitHub collaborators) push to the same repo. Commit/push is 1yef.3.
 *
 * Prod-path only: in dev-bypass there is no Supabase session, so this shows a
 * notice (mirrors SubscriptionSection).
 */
import { Button } from "@renderer/components/ui/button";
import { Separator } from "@renderer/components/ui/separator";
import { Toggle } from "@renderer/components/ui/toggle";
import { useAccount } from "@renderer/lib/account";
import { getActiveServer } from "@renderer/lib/server-registry";
import { supabase } from "@renderer/lib/supabase";
import type { AppSettings } from "@renderer/lib/types";
import {
  AlertTriangle,
  ExternalLink,
  Github,
  Loader2,
  Lock,
  Unlink,
  UploadCloud,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SectionHeader, SettingsRow } from "./shared";

interface GhStatus {
  connected: boolean;
  login?: string;
}
interface LinkedRepo {
  fullName: string;
  htmlUrl: string;
  isPrivate: boolean;
  cloudSynced: boolean;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

// Auto-reset the Connect flow if the browser authorize is abandoned (closed tab,
// redirect_uri mismatch) so the button never stays stuck on "Waiting for GitHub…".
const CONNECT_TIMEOUT_MS = 3 * 60_000;

export function BackupSection({ settings }: { settings: AppSettings }) {
  const { isDev, getToken, workspaceId } = useAccount();
  const [status, setStatus] = useState<GhStatus | null>(null);
  const [busy, setBusy] = useState<"connect" | "link" | "backup" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState<LinkedRepo | null>(null);
  const [linked, setLinked] = useState(false);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [isPrivate, setIsPrivate] = useState(true);
  const [autoBackup, setAutoBackup] = useState(false);
  const [secretWarnings, setSecretWarnings] = useState<{ line: number; directive: string }[]>([]);
  // Guards the loopback code listener so it only acts during an in-flight connect.
  const awaiting = useRef(false);
  // Safety timer that resets an abandoned Connect flow (paired with awaiting).
  const connectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearConnectTimer = useCallback(() => {
    if (connectTimer.current) {
      clearTimeout(connectTimer.current);
      connectTimer.current = null;
    }
  }, []);

  // Reset the in-flight Connect flow (Cancel button + timeout share this).
  const cancelConnect = useCallback(() => {
    clearConnectTimer();
    awaiting.current = false;
    setBusy(null);
    setError(null);
  }, [clearConnectTimer]);

  // Drop the safety timer if the component unmounts mid-connect.
  useEffect(() => clearConnectTimer, [clearConnectTimer]);

  const active = getActiveServer(settings);
  const serverPath = active?.serverPath;

  const refreshStatus = useCallback(async () => {
    setStatus(await window.api.backup.githubStatus());
  }, []);

  const refreshRepoStatus = useCallback(async () => {
    const r = await window.api.backup.repoStatus(serverPath);
    setLinked(r.linked);
  }, [serverPath]);

  useEffect(() => {
    if (!isDev) {
      void refreshStatus();
      void refreshRepoStatus();
      void window.api.backup.getAutoBackup().then((r) => setAutoBackup(r.enabled));
    }
  }, [isDev, refreshStatus, refreshRepoStatus]);

  // Receive the OAuth code from main's loopback, finish the link, and hand the
  // GitHub provider_token to main. Same channel as sign-in, but CustomAuth is
  // unmounted while signed in, so only this listener is active here.
  useEffect(() => {
    if (isDev) return;
    return window.api.onAuthSignInCode(async (code) => {
      if (!awaiting.current || !supabase) return;
      awaiting.current = false;
      clearConnectTimer();
      try {
        const { data, error: exErr } = await supabase.auth.exchangeCodeForSession(code);
        if (exErr) throw exErr;
        const token = data.session?.provider_token;
        if (!token) throw new Error("GitHub did not return an access token. Try connecting again.");
        const res = await window.api.backup.githubConnect(token);
        if (!res.ok) throw new Error(res.error ?? "Failed to verify the GitHub token.");
        await refreshStatus();
      } catch (err) {
        setError(errMsg(err));
      } finally {
        setBusy(null);
      }
    });
  }, [isDev, refreshStatus, clearConnectTimer]);

  const connect = useCallback(async () => {
    if (!supabase) {
      setError("Auth is not configured.");
      return;
    }
    setBusy("connect");
    setError(null);
    try {
      // Provider-agnostic loopback (returns the 127.0.0.1 redirect URI).
      const redirectTo = await window.api.startDiscordSignIn();
      awaiting.current = true;
      clearConnectTimer();
      connectTimer.current = setTimeout(() => {
        if (!awaiting.current) return;
        awaiting.current = false;
        connectTimer.current = null;
        setBusy(null);
        setError("GitHub sign-in timed out. Try connecting again.");
      }, CONNECT_TIMEOUT_MS);
      const { data, error: liErr } = await supabase.auth.linkIdentity({
        provider: "github",
        options: { scopes: "repo", skipBrowserRedirect: true, redirectTo },
      });
      if (liErr || !data?.url) throw liErr ?? new Error("No authorize URL returned.");
      await window.api.openExternal(data.url);
      // The onAuthSignInCode listener finishes the flow + clears busy.
    } catch (err) {
      cancelConnect();
      setError(errMsg(err));
    }
  }, [clearConnectTimer, cancelConnect]);

  const disconnect = useCallback(async () => {
    await window.api.backup.githubDisconnect();
    setRepo(null);
    await refreshStatus();
  }, [refreshStatus]);

  const linkRepo = useCallback(async () => {
    if (!serverPath) {
      setError("No active server is configured.");
      return;
    }
    setBusy("link");
    setError(null);
    setSecretWarnings([]);
    try {
      const accessToken = (await getToken()) ?? undefined;
      const res = await window.api.backup.linkRepo({
        serverPath,
        isPrivate,
        accessToken,
        workspaceId,
      });
      if (!res.ok) throw new Error(res.error ?? "Failed to link the repository.");
      setRepo({
        fullName: res.fullName ?? "",
        htmlUrl: res.htmlUrl ?? "",
        isPrivate: res.isPrivate ?? isPrivate,
        cloudSynced: res.cloudSynced ?? false,
      });
      setSecretWarnings(res.secretWarnings ?? []);
      setLinked(true);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(null);
    }
  }, [serverPath, isPrivate, getToken, workspaceId]);

  const backupNow = useCallback(async () => {
    if (!serverPath) {
      setError("No active server is configured.");
      return;
    }
    setBusy("backup");
    setError(null);
    setBackupMsg(null);
    try {
      const res = await window.api.backup.commitPush({ serverPath });
      if (!res.ok) throw new Error(res.error ?? "Backup failed.");
      setBackupMsg(
        res.nothingToCommit
          ? "Already up to date — nothing new to back up."
          : `Backed up and pushed${res.sha ? ` (${res.sha})` : ""}.`,
      );
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(null);
    }
  }, [serverPath]);

  const toggleAutoBackup = useCallback(async (next: boolean) => {
    setAutoBackup(next); // optimistic; main reads the persisted value each generation
    await window.api.backup.setAutoBackup(next);
  }, []);

  if (isDev) {
    return (
      <div className="space-y-0">
        <SectionHeader title="Backup" description="Back up a server folder to GitHub." />
        <Separator className="mb-1" />
        <div className="py-6 text-[11px] text-muted-foreground">
          Developer mode — GitHub backup uses your signed-in account, which is bypassed locally. Run
          the signed-in app to connect GitHub.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      <SectionHeader
        title="Backup"
        description="Back up a server folder to GitHub with full history. Team members get access via GitHub collaborator invites."
      />
      <Separator className="mb-1" />

      {status === null ? (
        <div className="flex items-center gap-1.5 py-6 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Checking GitHub connection…
        </div>
      ) : (
        <>
          <SettingsRow
            label="GitHub account"
            description={
              status.connected
                ? `Connected as @${status.login}.`
                : "Connect GitHub to push server backups. Requests the repo scope (private repos)."
            }
          >
            {status.connected ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 text-xs"
                onClick={disconnect}
              >
                <Unlink className="size-3" />
                Disconnect
              </Button>
            ) : (
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={connect}
                  disabled={busy === "connect"}
                >
                  {busy === "connect" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Github className="size-3" />
                  )}
                  {busy === "connect" ? "Waiting for GitHub…" : "Connect GitHub"}
                </Button>
                {busy === "connect" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-muted-foreground"
                    onClick={cancelConnect}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            )}
          </SettingsRow>

          {status.connected && (
            <>
              <Separator className="opacity-50" />
              <SettingsRow
                label="Private repository"
                description="Create the backup repo as private (recommended — server.cfg may hold secrets)."
              >
                <Toggle
                  size="sm"
                  variant="outline"
                  pressed={isPrivate}
                  onPressedChange={setIsPrivate}
                  aria-label="Toggle private repository"
                  className="h-7 gap-1.5 px-2.5 text-xs"
                >
                  <Lock className="size-3" />
                  {isPrivate ? "Private" : "Public"}
                </Toggle>
              </SettingsRow>
              <Separator className="opacity-50" />
              <SettingsRow
                label="Backup repository"
                description={
                  serverPath
                    ? `Create or link a GitHub repo for "${active?.name ?? serverPath}" and set its origin.`
                    : "Add a server first to back it up."
                }
              >
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1.5 text-xs"
                  onClick={linkRepo}
                  disabled={!serverPath || busy === "link"}
                >
                  {busy === "link" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Lock className="size-3" />
                  )}
                  {repo || linked ? "Re-link repo" : "Create / link repo"}
                </Button>
              </SettingsRow>

              {linked && (
                <>
                  <Separator className="opacity-50" />
                  <SettingsRow
                    label="Back up now"
                    description="Commit the server folder and push it to its GitHub repo."
                  >
                    <Button
                      size="sm"
                      className="h-7 gap-1.5 text-xs"
                      onClick={backupNow}
                      disabled={!serverPath || busy === "backup"}
                    >
                      {busy === "backup" ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <UploadCloud className="size-3" />
                      )}
                      {busy === "backup" ? "Backing up…" : "Back up now"}
                    </Button>
                  </SettingsRow>
                  <Separator className="opacity-50" />
                  <SettingsRow
                    label="Auto-backup"
                    description="Back up automatically after each generation (debounced). Make sure secrets are externalized first."
                  >
                    <Toggle
                      size="sm"
                      variant="outline"
                      pressed={autoBackup}
                      onPressedChange={(v) => void toggleAutoBackup(v)}
                      aria-label="Toggle auto-backup"
                      className="h-7 gap-1.5 px-2.5 text-xs"
                    >
                      <UploadCloud className="size-3" />
                      {autoBackup ? "On" : "Off"}
                    </Toggle>
                  </SettingsRow>
                </>
              )}
            </>
          )}

          {backupMsg && (
            <div className="mt-2 rounded-md border border-chart-2/20 bg-chart-2/[0.05] px-3 py-2.5">
              <p className="text-[11px] leading-relaxed text-chart-2">{backupMsg}</p>
            </div>
          )}

          {repo && (
            <div className="mt-2 rounded-md border border-chart-2/20 bg-chart-2/[0.05] px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-[11px] leading-relaxed text-chart-2">
                <Github className="size-3" />
                <span className="font-mono">{repo.fullName}</span>
                {repo.isPrivate ? <Lock className="size-2.5" /> : null}
                {repo.htmlUrl ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-0.5 underline-offset-2 hover:underline"
                    onClick={() => void window.api.openExternal(repo.htmlUrl)}
                  >
                    open <ExternalLink className="size-2.5" />
                  </button>
                ) : null}
              </p>
              {!repo.cloudSynced && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Linked locally — couldn't share the remote with your workspace (you can still
                  push).
                </p>
              )}
            </div>
          )}

          {secretWarnings.length > 0 && (
            <div className="mt-2 rounded-md border border-chart-3/30 bg-chart-3/[0.06] px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-chart-3">
                <AlertTriangle className="size-3" />
                Possible secrets in server.cfg — scrub before pushing
              </p>
              <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                {secretWarnings.map((w) => `L${w.line}: ${w.directive}`).join("  ·  ")}
              </p>
            </div>
          )}

          {error && (
            <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/[0.05] px-3 py-2.5">
              <p className="text-[11px] leading-relaxed text-destructive/80">{error}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
