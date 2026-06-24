import { ServerSwitcher } from "@renderer/components/ServerSwitcher";
import { Badge } from "@renderer/components/ui/badge";
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

// The old "Sessions" dropdown was retired (eh2g / fivem-studio-7omn): its list was
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
    <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border-subtle bg-surface px-3">
      {/* Toggle the conversation sidebar (eh2g) — click instead of drag-to-reopen */}
      <button
        type="button"
        onClick={onToggleSidebar}
        title="Toggle conversations"
        className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-elevated px-2 py-1 text-text-muted transition-colors hover:border-text-dim hover:text-text-primary"
      >
        <PanelLeft className="size-3.5" />
      </button>
      {/* Back to servers dashboard (m8se.2 / dnx8.3) */}
      <button
        type="button"
        onClick={onBackToServers}
        title="Servers"
        className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-elevated px-2 py-1 text-text-muted transition-colors hover:border-text-dim hover:text-text-primary"
      >
        <LayoutGrid className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onBrowseResources}
        title="Resources"
        className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-elevated px-2 py-1 text-text-muted transition-colors hover:border-text-dim hover:text-text-primary"
      >
        <FolderTree className="size-3.5" />
      </button>

      {/* Active server switcher (m8se.2) */}
      <ServerSwitcher settings={settings} />

      {/* Spacer */}
      <div className="flex-1" />

      {/* Live server status + quota (moved up from the bottom strip). */}
      {right}

      {/* Generation state badge */}
      <Badge variant="outline" className="h-5 font-mono text-[10px] font-normal">
        [{isGenerating ? "streaming" : "ready"}]
      </Badge>
    </div>
  );
}
