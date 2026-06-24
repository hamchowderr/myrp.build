/**
 * Add-a-server dialog (multi-server epic).
 *
 *  - "Add existing" (m8se.3): one click lists server folders found on disk via
 *    findServerPaths() (minus already-registered ones), plus a manual browse.
 *  - "Create new" (m8se.4): scaffold a fresh ox server folder (starter server.cfg
 *    + ox base) under a chosen location, then register it.
 *
 * Either path registers the server via addServer() and reloads so the
 * active-server cascade re-runs against the newly selected server.
 */
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@renderer/components/ui/tabs";
import { useAccount } from "@renderer/lib/account";
import { addServer, deriveServerName } from "@renderer/lib/server-registry";
import type { AppSettings } from "@renderer/lib/types";
import {
  AlertCircle,
  DownloadCloud,
  FolderOpen,
  Github,
  Loader2,
  Plus,
  Server,
} from "lucide-react";
import { useEffect, useState } from "react";

async function registerAndReload(settings: AppSettings, path: string): Promise<void> {
  await window.api.detectContext(path);
  const { settings: next } = addServer(settings, path);
  await window.api.saveSettings(next);
  window.location.reload();
}

export function AddServerDialog({
  settings,
  open,
  onOpenChange,
}: {
  settings: AppSettings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a server</DialogTitle>
          <DialogDescription>
            Register an existing FiveM server folder, or scaffold a fresh ox server.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="existing">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="existing">Add existing</TabsTrigger>
            <TabsTrigger value="create">Create new</TabsTrigger>
            <TabsTrigger value="restore">Restore</TabsTrigger>
          </TabsList>
          <TabsContent value="existing" className="pt-2">
            <AddExisting settings={settings} />
          </TabsContent>
          <TabsContent value="create" className="pt-2">
            <CreateNew settings={settings} />
          </TabsContent>
          <TabsContent value="restore" className="pt-2">
            <RestoreFromGitHub settings={settings} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function AddExisting({ settings }: { settings: AppSettings }) {
  const [paths, setPaths] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scan disk once on mount
  useEffect(() => {
    const registered = new Set(settings.servers.map((s) => s.serverPath));
    window.api
      .findServerPaths()
      .then((found) => setPaths(found.filter((p) => !registered.has(p))))
      .catch(() => setPaths([]));
  }, []);

  async function browse() {
    const path = await window.api.selectFolder();
    if (!path) return;
    setBusy(true);
    await registerAndReload(settings, path);
  }

  return (
    <div className="space-y-3">
      {paths === null ? (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Scanning for servers…
        </div>
      ) : paths.length > 0 ? (
        <div className="max-h-60 space-y-1.5 overflow-y-auto">
          {paths.map((path) => (
            <button
              type="button"
              key={path}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void registerAndReload(settings, path);
              }}
              className="flex w-full items-center gap-3 rounded-lg border border-border/40 bg-muted/20 p-3 text-left transition-colors hover:border-border/60 hover:bg-muted/30 disabled:opacity-50"
            >
              <Server className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{deriveServerName(path)}</div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">{path}</div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <p className="py-4 text-center text-xs text-muted-foreground">
          No new servers found on disk. Browse to a folder instead.
        </p>
      )}
      <Button variant="outline" className="w-full gap-2" disabled={busy} onClick={browse}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <FolderOpen className="size-4" />}
        Browse folder…
      </Button>
    </div>
  );
}

function CreateNew({ settings }: { settings: AppSettings }) {
  const [name, setName] = useState("");
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pickLocation() {
    const dir = await window.api.selectFolder();
    if (dir) setParentDir(dir);
  }

  async function create() {
    if (!name.trim() || !parentDir) return;
    setBusy(true);
    setError(null);
    setStatus("Scaffolding server + downloading ox base…");
    const result = await window.api.scaffoldServer(parentDir, name.trim());
    if ("error" in result) {
      setError(result.error);
      setBusy(false);
      setStatus(null);
      return;
    }
    if (result.failed.length > 0) {
      setStatus(`Created. Could not download: ${result.failed.join(", ")} — add them later.`);
    }
    await registerAndReload(settings, result.serverPath);
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="server-name">Server name</Label>
        <Input
          id="server-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My RP Server"
          disabled={busy}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Location</Label>
        <Button
          variant="outline"
          className="w-full justify-start gap-2 font-mono text-[11px]"
          disabled={busy}
          onClick={pickLocation}
        >
          <FolderOpen className="size-4 shrink-0" />
          <span className="truncate">{parentDir ?? "Choose a parent folder…"}</span>
        </Button>
      </div>
      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/10 p-2.5 text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="text-xs leading-relaxed">{error}</span>
        </div>
      )}
      {status && !error && <p className="text-xs text-muted-foreground">{status}</p>}
      <Button
        className="w-full gap-2"
        disabled={busy || !name.trim() || !parentDir}
        onClick={create}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        Create server
      </Button>
    </div>
  );
}

// Restore (clone) a backed-up server repo from GitHub (1yef.4). Lists the
// workspace's backups (cloud `servers` rows with a remote) and/or accepts a repo
// URL, clones into a chosen folder, then reuses registerAndReload so the restored
// server appears + activates. Prod-path only (needs the GitHub connection).
function RestoreFromGitHub({ settings }: { settings: AppSettings }) {
  const { isDev, getToken, workspaceId } = useAccount();
  const [backups, setBackups] = useState<{ name: string; remoteUrl: string }[] | null>(null);
  const [selectedUrl, setSelectedUrl] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: load backups once on mount
  useEffect(() => {
    if (isDev) {
      setBackups([]);
      return;
    }
    (async () => {
      const accessToken = (await getToken()) ?? undefined;
      const res = await window.api.backup.listBackups({ accessToken, workspaceId });
      setBackups(res.backups);
    })().catch(() => setBackups([]));
  }, []);

  const effectiveUrl = manualUrl.trim() || selectedUrl;

  async function pickLocation() {
    const dir = await window.api.selectFolder();
    if (dir) setParentDir(dir);
  }

  async function restore() {
    if (!effectiveUrl || !parentDir) return;
    setBusy(true);
    setError(null);
    const res = await window.api.backup.restore({ remoteUrl: effectiveUrl, parentDir });
    if (!res.ok || !res.localPath) {
      setError(res.error ?? "Restore failed.");
      setBusy(false);
      return;
    }
    await registerAndReload(settings, res.localPath);
  }

  if (isDev) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">
        Restore uses your signed-in GitHub connection, which is bypassed in developer mode. Run the
        signed-in app to restore a backup.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {backups === null ? (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading your backups…
        </div>
      ) : backups.length > 0 ? (
        <div className="max-h-44 space-y-1.5 overflow-y-auto">
          {backups.map((b) => {
            const active = selectedUrl === b.remoteUrl && !manualUrl;
            return (
              <button
                type="button"
                key={b.remoteUrl}
                disabled={busy}
                onClick={() => {
                  setSelectedUrl(b.remoteUrl);
                  setManualUrl("");
                }}
                className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors disabled:opacity-50 ${
                  active
                    ? "border-primary/60 bg-primary/5"
                    : "border-border/40 bg-muted/20 hover:border-border/60 hover:bg-muted/30"
                }`}
              >
                <Github className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{b.name}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    {b.remoteUrl}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="py-2 text-center text-xs text-muted-foreground">
          No backups found for this workspace. Paste a repo URL below.
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="restore-url">Or a GitHub repo URL</Label>
        <Input
          id="restore-url"
          value={manualUrl}
          onChange={(e) => setManualUrl(e.target.value)}
          placeholder="https://github.com/owner/repo.git"
          disabled={busy}
        />
      </div>

      <div className="space-y-1.5">
        <Label>Destination</Label>
        <Button
          variant="outline"
          className="w-full justify-start gap-2 font-mono text-[11px]"
          disabled={busy}
          onClick={pickLocation}
        >
          <FolderOpen className="size-4 shrink-0" />
          <span className="truncate">{parentDir ?? "Choose a parent folder…"}</span>
        </Button>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-chart-3/30 bg-chart-3/[0.06] p-2.5">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-chart-3" />
        <span className="text-[11px] leading-relaxed text-muted-foreground">
          Secrets aren't backed up — a restored server won't have its{" "}
          <span className="font-mono">myrp-secrets.cfg</span>. Re-add it before starting the server.
        </span>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/10 p-2.5 text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="text-xs leading-relaxed">{error}</span>
        </div>
      )}

      <Button
        className="w-full gap-2"
        disabled={busy || !effectiveUrl || !parentDir}
        onClick={restore}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <DownloadCloud className="size-4" />}
        Restore server
      </Button>
    </div>
  );
}
