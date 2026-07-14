import { ServerSwitcher } from "@renderer/components/ServerSwitcher";
import type { AppSettings } from "@renderer/lib/types";
import { FolderTree, LayoutGrid, PanelLeft } from "lucide-react";
import type { ReactNode } from "react";

interface HeaderBarProps {
  isGenerating: boolean;
  settings: AppSettings;
  onBackToServers: () => void;
  onBrowseResources: () => void;
  onToggleSidebar: () => void;
  /** Live server status + quota cluster, right-aligned (was the bottom StatusBar). */
  right?: ReactNode;
}

// The old "Sessions" dropdown was retired: its list was
// local prompt-history (not real conversations) and 3 of its 5 "commands" (/resume,
// /rename, /history) were decorative no-ops. Real session management now lives in
// the ConversationSidebar — list, open, rename, delete, New, Branch.
export function HeaderBar({
  isGenerating,
  settings,
  onBackToServers,
  onBrowseResources,
  onToggleSidebar,
  right,
}: HeaderBarProps) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2.5 bg-background px-3">
      {/* Toggle the conversation sidebar — click instead of drag-to-reopen */}
      <button
        type="button"
        onClick={onToggleSidebar}
        title="Toggle conversations"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-text-muted transition-colors hover:bg-elevated hover:text-text-primary"
      >
        <PanelLeft className="size-3.5" />
      </button>
      {/* Back to servers dashboard */}
      <button
        type="button"
        onClick={onBackToServers}
        title="Servers"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-text-muted transition-colors hover:bg-elevated hover:text-text-primary"
      >
        <LayoutGrid className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onBrowseResources}
        title="Resources"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-text-muted transition-colors hover:bg-elevated hover:text-text-primary"
      >
        <FolderTree className="size-3.5" />
      </button>

      {/* Active server switcher */}
      <ServerSwitcher settings={settings} />

      {/* Spacer */}
      <div className="flex-1" />

      {/* Live server status + quota (moved up from the bottom strip). */}
      {right}

      {/* Generation state — plain subtle text, no boxed border (calm cluster). */}
      <span className="font-mono text-[10px] text-text-dim">
        [{isGenerating ? "streaming" : "ready"}]
      </span>
    </div>
  );
}
