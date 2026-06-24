/**
 * Resource / output browser (fivem-studio-dnx8.4).
 *
 * Browse and manage everything generated for the active server outside the chat
 * thread: the resources under [local], each resource's files, its generation
 * version history (manifests), and restore/undo + delete. Composes the existing
 * IPC (listResources/listDir/listManifests/undoGeneration/deleteResource/
 * openInExplorer) and the useFileTree hook — no new main-process surface.
 */
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { useFileTree } from "@renderer/hooks/useFileTree";
import { getActiveServer } from "@renderer/lib/server-registry";
import type { AppSettings, ManifestSummary } from "@renderer/lib/types";
import {
  ArrowLeft,
  ExternalLink,
  FileCode,
  FolderTree,
  History,
  Loader2,
  RotateCcw,
  Server,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

function relTime(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function ResourceBrowser({
  settings,
  onBack,
}: {
  settings: AppSettings;
  onBack: () => void;
}) {
  const active = getActiveServer(settings);
  const localPath = active?.localPath ?? "";
  const tree = useFileTree(localPath, null);
  const [selected, setSelected] = useState<string | null>(null);
  const [manifests, setManifests] = useState<ManifestSummary[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);

  const loadManifests = useCallback(async () => {
    if (!localPath) return;
    try {
      setManifests(await window.api.listManifests(localPath));
    } catch {
      setManifests([]);
    }
  }, [localPath]);

  useEffect(() => {
    loadManifests();
  }, [loadManifests]);

  // Files for the selected resource (reuse the tree's per-resource expansion).
  // toggleResource is a stable useCallback, so this runs only when selected changes.
  const { toggleResource } = tree;
  useEffect(() => {
    if (selected) toggleResource(selected);
  }, [selected, toggleResource]);

  const files = selected ? (tree.resourceFiles.get(selected) ?? []) : [];
  const history = selected ? manifests.filter((m) => m.resourceName === selected) : [];

  async function restore(manifestPath: string) {
    setRestoring(manifestPath);
    try {
      await window.api.undoGeneration(manifestPath);
      await tree.refreshResources();
      await loadManifests();
      setSelected(null);
    } finally {
      setRestoring(null);
    }
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/40 px-4">
        <Button variant="ghost" size="sm" className="size-8 p-0" onClick={onBack} title="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <FolderTree className="size-4 text-muted-foreground" />
        <span className="font-semibold">Resources</span>
        {active && (
          <span className="font-mono text-[11px] text-muted-foreground">· {active.name}</span>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Resource list */}
        <div className="w-64 shrink-0 border-r border-border/40">
          <ScrollArea className="h-full">
            <div className="p-2">
              {tree.loadingResources ? (
                <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Loading…
                </div>
              ) : tree.serverResources.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">No generated resources yet.</p>
              ) : (
                tree.serverResources.map((name) => (
                  <button
                    type="button"
                    key={name}
                    onClick={() => setSelected(name)}
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                      selected === name ? "bg-primary/15 text-primary" : "hover:bg-muted/40"
                    }`}
                  >
                    <Server className="size-3.5 shrink-0 opacity-70" />
                    <span className="truncate">{name}</span>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Detail */}
        <ScrollArea className="flex-1">
          {!selected ? (
            <div className="grid h-full place-items-center p-8 text-sm text-muted-foreground">
              Select a resource to view its files and version history.
            </div>
          ) : (
            <div className="space-y-6 p-6">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">{selected}</h2>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => window.api.openInExplorer(`${localPath}/${selected}`)}
                  >
                    <ExternalLink className="size-3.5" /> Explorer
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 text-destructive"
                    onClick={() => tree.handleDelete(selected)}
                  >
                    <Trash2 className="size-3.5" /> Delete
                  </Button>
                </div>
              </div>

              {/* Files */}
              <section>
                <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <FileCode className="size-3.5" /> Files
                </div>
                {tree.loadingFiles === selected ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Loading files…
                  </div>
                ) : (
                  <div className="rounded-lg border border-border/40 bg-card">
                    {files.length === 0 ? (
                      <p className="p-3 text-xs text-muted-foreground">No files.</p>
                    ) : (
                      files.map((f) => (
                        <div
                          key={f.absolutePath}
                          className="border-border/30 border-b px-3 py-1.5 font-mono text-[11px] text-muted-foreground last:border-0"
                        >
                          {f.relativePath}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </section>

              {/* Version history */}
              <section>
                <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <History className="size-3.5" /> Version history
                </div>
                {history.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No generation manifests recorded.</p>
                ) : (
                  <div className="space-y-2">
                    {history.map((m) => (
                      <div
                        key={m.manifestPath}
                        className="flex items-center justify-between rounded-lg border border-border/40 bg-card px-3 py-2"
                      >
                        <div className="text-xs">
                          <div className="font-medium">{m.fileCount} files</div>
                          <div className="text-muted-foreground">{relTime(m.createdAt)}</div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          disabled={restoring === m.manifestPath}
                          onClick={() => restore(m.manifestPath)}
                        >
                          {restoring === m.manifestPath ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <RotateCcw className="size-3.5" />
                          )}
                          Restore
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}
