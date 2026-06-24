import { ScrollArea } from "@renderer/components/ui/scroll-area";
import type { UseFileTreeReturn } from "@renderer/hooks/useFileTree";
import type { SelectedFile } from "@renderer/hooks/useFileViewer";
import type { GenerationResult } from "@renderer/lib/types";
import {
  Braces,
  Database,
  File,
  FileCode,
  FileJson,
  FolderTree,
  Globe,
  Loader2,
  Palette,
  Play,
  RotateCcw,
  Settings,
  Square,
  Trash2,
} from "lucide-react";

/** Map file extension to a descriptive icon */
function fileIcon(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  const name = path.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (name === "fxmanifest.lua") return <FileJson className="size-2.5 shrink-0 text-amber-400" />;
  if (ext === "lua") return <FileCode className="size-2.5 shrink-0 text-blue-400" />;
  if (ext === "sql") return <Database className="size-2.5 shrink-0 text-emerald-400" />;
  if (ext === "html" || ext === "htm")
    return <Globe className="size-2.5 shrink-0 text-orange-400" />;
  if (ext === "css") return <Palette className="size-2.5 shrink-0 text-pink-400" />;
  if (ext === "js" || ext === "ts") return <Braces className="size-2.5 shrink-0 text-yellow-400" />;
  if (ext === "json") return <FileJson className="size-2.5 shrink-0 text-amber-400" />;
  if (ext === "cfg") return <Settings className="size-2.5 shrink-0 text-text-dim" />;
  return <File className="size-2.5 shrink-0 text-text-dim" />;
}

interface FileTreePanelProps {
  tree: UseFileTreeReturn;
  lastResult: GenerationResult | null;
  selectedFile: SelectedFile | null;
  onFileClick: (resourceName: string, absolutePath: string, relativePath: string) => void;
}

export function FileTreePanel({ tree, lastResult, selectedFile, onFileClick }: FileTreePanelProps) {
  const {
    serverResources,
    expandedResource,
    resourceFiles,
    loadingResources,
    loadingFiles,
    confirmDelete,
    deleting,
    setConfirmDelete,
    toggleResource,
    handleDelete,
    controlling,
    controlError,
    controlResource,
  } = tree;

  return (
    <ScrollArea className="w-56 shrink-0">
      <div className="space-y-0.5 p-2">
        {loadingResources ? (
          <div className="space-y-1.5 p-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-5 animate-pulse rounded bg-surface-alt"
                style={{ width: `${60 + Math.random() * 30}%` }}
              />
            ))}
          </div>
        ) : serverResources.length === 0 ? (
          <p className="p-2 text-center font-mono text-xs text-text-dim">No resources found</p>
        ) : (
          serverResources.map((name) => {
            const isExpanded = expandedResource === name;
            const files = resourceFiles.get(name);
            const isGenerated = lastResult?.resourceName === name;
            const isConfirming = confirmDelete === name;
            const isDeleting = deleting === name;
            return (
              <div key={name}>
                <div
                  className={`group flex w-full items-center gap-1.5 rounded px-2 py-1 text-left font-mono text-xs transition-colors ${
                    isConfirming
                      ? "bg-red-500/10"
                      : isExpanded
                        ? "bg-primary/10 text-text-primary"
                        : "text-text-muted hover:bg-hover hover:text-text-primary"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggleResource(name)}
                    className="flex min-w-0 flex-1 items-center gap-1.5"
                  >
                    <FolderTree className="size-3 shrink-0" />
                    <span className="flex-1 truncate text-left">{name}</span>
                  </button>
                  {isGenerated && (
                    <span className="shrink-0 rounded-sm bg-primary/10 px-1 text-[8px] text-primary">
                      new
                    </span>
                  )}
                  {isConfirming ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleDelete(name)}
                        disabled={isDeleting}
                        className="rounded bg-red-600 px-1.5 py-0.5 text-[9px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        {isDeleting ? <Loader2 className="size-2.5 animate-spin" /> : "Delete"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(null)}
                        className="rounded px-1.5 py-0.5 text-[9px] text-text-dim hover:text-text-primary"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(name);
                      }}
                      className="shrink-0 rounded p-0.5 text-text-dim opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </div>
                {isExpanded && (
                  <div className="space-y-0.5 py-0.5 pl-4">
                    {/* Live controls via txAdmin — restart / stop / start the resource */}
                    <div className="flex items-center gap-0.5 px-2 pb-1">
                      {(["restart", "stop", "start"] as const).map((action) => {
                        const busy = controlling?.name === name && controlling.action === action;
                        const Icon =
                          action === "restart" ? RotateCcw : action === "stop" ? Square : Play;
                        return (
                          <button
                            key={action}
                            type="button"
                            onClick={() => controlResource(name, action)}
                            disabled={controlling !== null}
                            title={`${action} resource (txAdmin)`}
                            className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] text-text-dim transition-colors hover:bg-hover hover:text-text-primary disabled:opacity-40"
                          >
                            {busy ? (
                              <Loader2 className="size-2.5 animate-spin" />
                            ) : (
                              <Icon className="size-2.5" />
                            )}
                            <span className="capitalize">{action}</span>
                          </button>
                        );
                      })}
                    </div>
                    {controlError?.name === name && (
                      <p className="px-2 pb-1 font-mono text-[9px] text-red-400">
                        {controlError.error}
                      </p>
                    )}
                    {loadingFiles === name ? (
                      <div className="space-y-1 py-1">
                        {Array.from({ length: 3 }).map((_, i) => (
                          <div
                            key={i}
                            className="ml-2 h-4 animate-pulse rounded bg-surface-alt"
                            style={{
                              width: `${50 + Math.random() * 40}%`,
                            }}
                          />
                        ))}
                      </div>
                    ) : files && files.length > 0 ? (
                      files.map((f) => (
                        <button
                          type="button"
                          key={f.absolutePath}
                          onClick={() => onFileClick(name, f.absolutePath, f.relativePath)}
                          className={`flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-left font-mono text-[10px] transition-colors ${
                            selectedFile?.absolutePath === f.absolutePath
                              ? "bg-primary/10 text-primary"
                              : "text-text-dim hover:bg-hover hover:text-text-primary"
                          }`}
                        >
                          {fileIcon(f.relativePath)}
                          <span className="flex-1 truncate">{f.relativePath}</span>
                        </button>
                      ))
                    ) : (
                      <p className="px-2 py-1 font-mono text-[10px] text-text-dim">
                        Empty resource
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </ScrollArea>
  );
}
