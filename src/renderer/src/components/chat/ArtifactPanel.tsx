import { NuiPreview } from "@renderer/components/builder/NuiPreview";
import { ServerConsolePanel } from "@renderer/components/builder/ServerConsolePanel";
import { TestingPanel } from "@renderer/components/builder/TestingPanel";
import { Button } from "@renderer/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@renderer/components/ui/tabs";
import { useFileTree } from "@renderer/hooks/useFileTree";
import { useFileViewer } from "@renderer/hooks/useFileViewer";
import type { ServerStatus } from "@renderer/hooks/useServerStatus";
import { type ExtractedCoordinate, extractCoordinates } from "@renderer/lib/coordinate-parser";
import type { ConsoleEntry, GenerationResult, ToolLogEntry } from "@renderer/lib/types";
import {
  Eye,
  FlaskConical,
  FolderTree,
  Loader2,
  MapPin,
  MonitorPlay,
  RefreshCw,
  Terminal,
  Undo2,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { FileTreePanel } from "./artifacts/FileTreePanel";
import { FileViewerPanel } from "./artifacts/FileViewerPanel";

const GtaMap = lazy(() =>
  import("@renderer/components/map/GtaMap").then((m) => ({
    default: m.GtaMap,
  })),
);

const GameViewPanel = lazy(() =>
  import("@renderer/components/builder/GameViewPanel").then((m) => ({
    default: m.GameViewPanel,
  })),
);

type PreviewSource = { resourceName: string; htmlPath: string; htmlContent: string };

interface ArtifactPanelProps {
  lastResult: GenerationResult | null;
  canUndo: boolean;
  onUndo: () => Promise<void>;
  onDeleteResource?: (name: string) => void;
  toolLog: ToolLogEntry[];
  isGenerating: boolean;
  localPath: string;
  serverCfgPath: string;
  serverStatus: ServerStatus | null;
  onRestart: (name: string) => Promise<{ ok: boolean; error?: string }>;
  consoleEntries: ConsoleEntry[];
  onClearConsole: () => void;
}

export function ArtifactPanel({
  lastResult,
  canUndo,
  onUndo,
  onDeleteResource,
  toolLog: _toolLog,
  isGenerating: _isGenerating,
  localPath,
  serverCfgPath: _serverCfgPath,
  serverStatus,
  onRestart,
  consoleEntries,
  onClearConsole,
}: ArtifactPanelProps) {
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartMsg, setRestartMsg] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("files");
  // Keep-alive: once a tab has been opened, keep it mounted (forceMount) so
  // switching back is instant instead of remounting + re-running its loading
  // (which flashed an empty/error-looking state). Lazy tabs still defer their
  // first mount until first opened, so nothing loads upfront.
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(() => new Set(["files"]));

  // NUI preview state. `nuiPick` is the resource explicitly chosen in the NUI
  // Preview tab's switcher (uny); it overrides the file-tree-expansion coupling.
  const [previewSource, setPreviewSource] = useState<PreviewSource | null>(null);
  const [nuiPick, setNuiPick] = useState<string | null>(null);

  // Map coordinates state
  const [mapCoordinates, setMapCoordinates] = useState<ExtractedCoordinate[]>([]);
  const [mapParsedFor, setMapParsedFor] = useState<string | null>(null);

  const viewer = useFileViewer();
  const tree = useFileTree(localPath, lastResult, onDeleteResource, (name) => {
    viewer.clearForResource(name);
    setPreviewSource((prev) => (prev?.resourceName === name ? null : prev));
    setNuiPick((prev) => (prev === name ? null : prev));
  });

  const canRestart = !!lastResult && !!serverStatus?.online && !!onRestart;

  const handleRestart = useCallback(async () => {
    if (!lastResult || !onRestart) return;
    setIsRestarting(true);
    setRestartMsg(null);
    const res = await onRestart(lastResult.resourceName);
    setIsRestarting(false);
    setRestartMsg(res.ok ? "Restarted!" : (res.error ?? "Failed"));
    setTimeout(() => setRestartMsg(null), 3000);
  }, [lastResult, onRestart]);

  // Load a resource's NUI (first .html/.htm under its folder) for the preview.
  // Reads from disk directly so the switcher can jump to a resource whose files
  // aren't cached in the file tree yet.
  const loadNui = useCallback(
    async (resourceName: string): Promise<PreviewSource | null> => {
      try {
        const files = await window.api.listDir(`${localPath}/${resourceName}`);
        const html = files.find(
          (f) =>
            f.relativePath.toLowerCase().endsWith(".html") ||
            f.relativePath.toLowerCase().endsWith(".htm"),
        );
        if (!html) return null;
        const content = await window.api.readFile(html.absolutePath);
        return { resourceName, htmlPath: html.absolutePath, htmlContent: content };
      } catch {
        return null;
      }
    },
    [localPath],
  );

  // A fresh generation should surface its own NUI — drop any manual switcher pick
  // so the priority falls through to the freshly generated (auto-expanded) resource.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the generated resource changes
  useEffect(() => {
    setNuiPick(null);
  }, [lastResult?.resourceName]);

  // Auto-select first file when a resource expands and its files load.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed only on the expanded resource/files — adding the viewer deps would re-fire on every selection change and fight manual file selection
  useEffect(() => {
    if (!tree.expandedResource) return;
    const files = tree.resourceFiles.get(tree.expandedResource);
    if (!files || files.length === 0) return;
    if (viewer.selectedFile?.resourceName === tree.expandedResource) return;
    const first = files[0];
    viewer.handleFileClick(tree.expandedResource, first.absolutePath, first.relativePath);
  }, [tree.expandedResource, tree.resourceFiles]);

  // Resolve which resource's NUI to preview, then load it. Priority: the explicit
  // switcher pick (uny) → the file-tree's expanded resource → the last generated
  // resource → the first NUI resource. Only resources that actually ship an NUI
  // (tree.nuiResources — the set behind the file-tree "previewable" badge) are
  // eligible, so the tab is no longer coupled to file-tree expansion.
  useEffect(() => {
    const nui = tree.nuiResources;
    const has = (n: string | null | undefined): n is string => !!n && nui.has(n);
    const lastName = lastResult?.resourceName;
    const target =
      (has(nuiPick) && nuiPick) ||
      (has(tree.expandedResource) && tree.expandedResource) ||
      (has(lastName) && lastName) ||
      (nui.size > 0 ? [...nui].sort()[0] : null);
    if (!target) {
      setPreviewSource(null);
      return;
    }
    let cancelled = false;
    loadNui(target).then((src) => {
      if (!cancelled) setPreviewSource(src);
    });
    return () => {
      cancelled = true;
    };
  }, [nuiPick, tree.expandedResource, tree.nuiResources, lastResult, loadNui]);

  // Parse coordinates when Map tab is active and resource changes
  useEffect(() => {
    const targetResource = tree.expandedResource ?? lastResult?.resourceName;
    if (activeTab !== "map" || !targetResource || !localPath) return;
    if (mapParsedFor === targetResource) return;

    const files = tree.resourceFiles.get(targetResource);
    if (!files) return;

    let cancelled = false;
    (async () => {
      const fileContents: Array<{ name: string; content: string }> = [];
      for (const f of files) {
        try {
          const content = await window.api.readFile(f.absolutePath);
          fileContents.push({ name: f.relativePath, content });
        } catch {
          // skip unreadable files
        }
      }
      if (cancelled) return;
      const coords = extractCoordinates(fileContents);
      setMapCoordinates(coords);
      setMapParsedFor(targetResource);
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTab, tree.expandedResource, lastResult, localPath, tree.resourceFiles, mapParsedFor]);

  // Soft segmented pills (no hard underline) — active = brand tint, matching the
  // file-tree / sidebar active states so the whole right panel reads as one piece.
  // The explicit dark: overrides are needed to beat the shadcn base, which tints
  // the active tab grey (dark:bg-input/30 + border-input + text-foreground).
  const tabTriggerClass =
    "flex-none gap-1.5 rounded-md border-transparent px-3 py-1.5 font-mono text-[10px] text-text-dim transition-colors hover:bg-hover hover:text-text-secondary data-[state=active]:border-transparent data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-primary/10 dark:data-[state=active]:text-primary";

  return (
    <div className="flex h-full flex-col bg-surface" data-tour-step-id="artifact-panel">
      {/* Tabs + panel actions share one band. The active resource already shows
          in the file tree and the file-viewer breadcrumb, so a separate
          "Resource:" header would just be another redundant line. */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          setActiveTab(v);
          setVisitedTabs((prev) => (prev.has(v) ? prev : new Set(prev).add(v)));
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="relative flex shrink-0 items-center justify-center">
          <TabsList className="h-auto justify-center gap-1.5 rounded-none border-0 bg-transparent py-1.5">
            <TabsTrigger value="files" className={tabTriggerClass}>
              <FolderTree className="size-3" />
              Files
              {tree.serverResources.length > 0 && (
                <span className="ml-1 rounded-sm bg-surface-alt px-1 text-[8px] text-text-dim">
                  {tree.serverResources.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger
              value="terminal"
              className={tabTriggerClass}
              data-tour-step-id="terminal-tab"
            >
              <Terminal className="size-3" />
              Terminal
            </TabsTrigger>
            <TabsTrigger value="nuiPreview" className={tabTriggerClass}>
              <MonitorPlay className="size-3" />
              NUI Preview
            </TabsTrigger>
            <TabsTrigger value="map" className={tabTriggerClass}>
              <MapPin className="size-3" />
              Map
              {mapCoordinates.length > 0 && (
                <span className="ml-1 rounded-sm bg-surface-alt px-1 text-[8px] text-text-dim">
                  {mapCoordinates.length}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="gameview" className={tabTriggerClass}>
              <Eye className="size-3" />
              Game View
            </TabsTrigger>
            <TabsTrigger value="testing" className={tabTriggerClass}>
              <FlaskConical className="size-3" />
              Testing
            </TabsTrigger>
          </TabsList>
          {activeTab === "files" && (canRestart || canUndo) && (
            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
              {canRestart && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 font-mono text-[10px]"
                  onClick={handleRestart}
                  disabled={isRestarting}
                >
                  {isRestarting ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3" />
                  )}
                  {restartMsg ?? "Restart"}
                </Button>
              )}
              {canUndo && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 font-mono text-[10px]"
                  onClick={onUndo}
                >
                  <Undo2 className="size-3" />
                  Undo
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Files tab */}
        <TabsContent
          value="files"
          forceMount={visitedTabs.has("files") ? true : undefined}
          className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          <div className="flex h-full">
            <FileTreePanel
              tree={tree}
              lastResult={lastResult}
              selectedFile={viewer.selectedFile}
              onFileClick={viewer.handleFileClick}
            />
            <FileViewerPanel viewer={viewer} />
          </div>
        </TabsContent>

        {/* Terminal tab */}
        <TabsContent
          value="terminal"
          forceMount={visitedTabs.has("terminal") ? true : undefined}
          className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          <ServerConsolePanel entries={consoleEntries} onClear={onClearConsole} />
        </TabsContent>

        {/* NUI Preview tab */}
        <TabsContent
          value="nuiPreview"
          forceMount={visitedTabs.has("nuiPreview") ? true : undefined}
          className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          {previewSource ? (
            <div className="flex h-full flex-col">
              <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle/40 bg-elevated px-3 py-1">
                <MonitorPlay className="size-3 shrink-0 text-primary" />
                {/* Resource switcher (uny): pick which resource's NUI to preview,
                    independent of what's expanded in the Files tab. */}
                {tree.nuiResources.size > 1 ? (
                  <select
                    value={previewSource.resourceName}
                    onChange={(e) => setNuiPick(e.target.value)}
                    aria-label="Select which resource's NUI to preview"
                    className="max-w-[200px] rounded bg-transparent font-mono text-[10px] text-text-muted outline-none [&>option]:bg-neutral-900"
                  >
                    {[...tree.nuiResources].sort().map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="font-mono text-[10px] text-text-muted">
                    {previewSource.resourceName}
                  </span>
                )}
                <span className="truncate font-mono text-[9px] text-text-dim">
                  {previewSource.htmlPath.split(/[/\\]/).pop()}
                </span>
              </div>
              <div className="min-h-0 flex-1">
                <NuiPreview
                  absolutePath={previewSource.htmlPath}
                  content={previewSource.htmlContent}
                />
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-text-dim">
              <div className="text-center font-mono text-xs">
                <MonitorPlay className="mx-auto mb-2 size-8 opacity-30" />
                <p>No resources with an NUI page to preview</p>
              </div>
            </div>
          )}
        </TabsContent>

        {/* Map tab */}
        <TabsContent
          value="map"
          forceMount={visitedTabs.has("map") ? true : undefined}
          className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-text-dim" />
              </div>
            }
          >
            <GtaMap
              coordinates={mapCoordinates}
              onMarkerClick={(coord) => {
                const targetResource = tree.expandedResource ?? lastResult?.resourceName;
                if (!targetResource) return;
                const files = tree.resourceFiles.get(targetResource);
                if (!files) return;
                const matchFile = files.find(
                  (f) =>
                    f.relativePath === coord.source.file ||
                    f.relativePath.endsWith(coord.source.file),
                );
                if (matchFile) {
                  setActiveTab("files");
                  viewer.handleFileClick(
                    targetResource,
                    matchFile.absolutePath,
                    matchFile.relativePath,
                  );
                }
              }}
            />
          </Suspense>
        </TabsContent>

        {/* Game View tab */}
        <TabsContent
          value="gameview"
          forceMount={visitedTabs.has("gameview") ? true : undefined}
          className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-text-dim" />
              </div>
            }
          >
            <GameViewPanel />
          </Suspense>
        </TabsContent>

        {/* Testing tab — smoke-test + playtest checklist */}
        <TabsContent
          value="testing"
          forceMount={visitedTabs.has("testing") ? true : undefined}
          className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        >
          <TestingPanel resources={tree.serverResources} serverStatus={serverStatus} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
