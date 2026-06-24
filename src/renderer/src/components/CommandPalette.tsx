/**
 * Global command palette (Cmd/Ctrl-K) — fivem-studio-dnx8.1.
 *
 * A cmdk CommandDialog over an action registry: navigate the app shell (Servers
 * dashboard, Settings), switch the active server (one item per registered
 * server, cascading via onOpenServer), add a server, and toggle the theme.
 * Mounted once in AppContent so it's reachable from every screen. Chat-scoped
 * actions (new thread, clone) land with dnx8.2.
 */
import { AddServerDialog } from "@renderer/components/AddServerDialog";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@renderer/components/ui/command";
import { getActiveServer } from "@renderer/lib/server-registry";
import type { AppSettings } from "@renderer/lib/types";
import { FolderTree, LayoutGrid, Moon, Plus, Server, Settings, Terminal } from "lucide-react";
import { useState } from "react";

export function CommandPalette({
  settings,
  open,
  onOpenChange,
  onGoToDashboard,
  onOpenServer,
  onOpenSettings,
  onBrowseResources,
  onOpenDeploy,
  onToggleTheme,
}: {
  settings: AppSettings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGoToDashboard: () => void;
  onOpenServer: (id: string) => void;
  onOpenSettings: () => void;
  onBrowseResources: () => void;
  onOpenDeploy: () => void;
  onToggleTheme: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const active = getActiveServer(settings);

  // Run an action and close the palette.
  const run = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  return (
    <>
      <CommandDialog open={open} onOpenChange={onOpenChange}>
        <CommandInput placeholder="Type a command or search…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>

          <CommandGroup heading="Navigation">
            <CommandItem onSelect={run(onGoToDashboard)}>
              <LayoutGrid className="size-4" />
              Go to Servers
            </CommandItem>
            <CommandItem onSelect={run(onBrowseResources)}>
              <FolderTree className="size-4" />
              Browse resources
            </CommandItem>
            <CommandItem onSelect={run(onOpenDeploy)}>
              <Terminal className="size-4" />
              Deploy &amp; monitor
            </CommandItem>
            <CommandItem onSelect={run(onOpenSettings)}>
              <Settings className="size-4" />
              Open Settings
            </CommandItem>
            <CommandItem onSelect={run(onToggleTheme)}>
              <Moon className="size-4" />
              Toggle theme
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />

          <CommandGroup heading="Servers">
            {settings.servers.map((s) => (
              <CommandItem
                key={s.id}
                value={`switch ${s.name} ${s.serverPath}`}
                onSelect={run(() => onOpenServer(s.id))}
              >
                <Server className="size-4" />
                <span className="flex-1">
                  {s.id === active?.id ? "Open" : "Switch to"} {s.name}
                </span>
                {s.id === active?.id && (
                  <span className="font-mono text-[9px] uppercase tracking-wide text-primary">
                    active
                  </span>
                )}
              </CommandItem>
            ))}
            <CommandItem value="add create server" onSelect={run(() => setAddOpen(true))}>
              <Plus className="size-4" />
              Add a server…
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>

      <AddServerDialog settings={settings} open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}
