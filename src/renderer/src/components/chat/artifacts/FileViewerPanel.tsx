import { ColorizedCode } from "@renderer/components/builder/ColorizedCode";
import { NuiPreview } from "@renderer/components/builder/NuiPreview";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group";
import type { UseFileViewerReturn } from "@renderer/hooks/useFileViewer";
import { Code2, Eye, FileCode, Loader2, Pencil, Save, X } from "lucide-react";

interface FileViewerPanelProps {
  viewer: UseFileViewerReturn;
}

export function FileViewerPanel({ viewer }: FileViewerPanelProps) {
  const {
    selectedFile,
    fileContent,
    fileLoading,
    viewMode,
    setViewMode,
    editMode,
    editContent,
    saving,
    modified,
    selectedIsHtml,
    toggleEditMode,
    handleSave,
    setEditContent,
    setModified,
  } = viewer;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* Breadcrumb + view toggle + edit controls */}
      {selectedFile && fileContent !== null && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border-subtle/40 px-2 py-1">
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <span className="truncate font-mono text-[10px] text-text-dim">
              {selectedFile.resourceName}
            </span>
            <span className="text-[10px] text-text-dim/30">/</span>
            <span className="truncate font-mono text-[10px] text-text-primary">
              {selectedFile.relativePath}
            </span>
            {modified && (
              <span className="shrink-0 rounded-sm bg-amber-500/20 px-1 text-[8px] text-amber-400">
                modified
              </span>
            )}
          </div>
          {/* Edit controls */}
          {editMode && modified && (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-accent-green transition-colors hover:bg-accent-green/10 disabled:opacity-50"
            >
              {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
              Save
            </button>
          )}
          {editMode && modified && (
            <button
              type="button"
              onClick={() => {
                setEditContent(fileContent ?? "");
                setModified(false);
              }}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-text-dim transition-colors hover:text-text-primary"
            >
              <X className="size-3" />
              Discard
            </button>
          )}
          <button
            type="button"
            onClick={toggleEditMode}
            className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
              editMode ? "bg-primary/15 text-primary" : "text-text-dim hover:text-text-primary"
            }`}
          >
            <Pencil className="size-3" />
            Edit
          </button>
          {selectedIsHtml && !editMode && (
            <ToggleGroup
              type="single"
              value={viewMode}
              onValueChange={(v) => v && setViewMode(v as "code" | "preview")}
              className="shrink-0"
            >
              <ToggleGroupItem
                value="code"
                className="h-5 gap-1 px-1.5 font-mono text-[10px]"
                aria-label="View source code"
              >
                <Code2 className="size-3" />
                Code
              </ToggleGroupItem>
              <ToggleGroupItem
                value="preview"
                className="h-5 gap-1 px-1.5 font-mono text-[10px]"
                aria-label="Preview NUI"
              >
                <Eye className="size-3" />
                Preview
              </ToggleGroupItem>
            </ToggleGroup>
          )}
        </div>
      )}

      {/* File content */}
      {viewMode === "preview" &&
      selectedIsHtml &&
      !editMode &&
      fileContent !== null &&
      selectedFile !== null ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <NuiPreview absolutePath={selectedFile.absolutePath} content={fileContent} />
        </div>
      ) : fileLoading ? (
        <div className="space-y-2 p-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-3 animate-pulse rounded bg-surface-alt"
              style={{ width: `${40 + Math.random() * 50}%` }}
            />
          ))}
        </div>
      ) : fileContent !== null && selectedFile !== null ? (
        editMode ? (
          <textarea
            value={editContent}
            onChange={(e) => {
              setEditContent(e.target.value);
              setModified(e.target.value !== fileContent);
            }}
            onKeyDown={(e) => {
              if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (modified) handleSave();
              }
              if (e.key === "Tab") {
                e.preventDefault();
                const target = e.currentTarget;
                const start = target.selectionStart;
                const end = target.selectionEnd;
                const value = target.value;
                const newValue = `${value.substring(0, start)}  ${value.substring(end)}`;
                setEditContent(newValue);
                setModified(newValue !== fileContent);
                requestAnimationFrame(() => {
                  target.selectionStart = target.selectionEnd = start + 2;
                });
              }
            }}
            spellCheck={false}
            className="h-full w-full resize-none border-0 bg-transparent p-3 font-mono text-xs leading-relaxed text-text-primary outline-none focus:ring-0 focus:ring-inset focus:ring-primary/20"
          />
        ) : (
          <ScrollArea className="h-full">
            <ColorizedCode content={fileContent} path={selectedFile.absolutePath} />
          </ScrollArea>
        )
      ) : (
        <div className="flex flex-1 items-center justify-center text-text-dim">
          <div className="text-center font-mono text-xs">
            <FileCode className="mx-auto mb-2 size-8 opacity-30" />
            <p>Select a file to view</p>
          </div>
        </div>
      )}
    </div>
  );
}
