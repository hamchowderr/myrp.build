/**
 * Server switcher (multi-server epic m8se, fivem-studio-m8se.2).
 *
 * A compact header dropdown listing every registered FiveM server, with a check
 * on the active one. Selecting a server flips AppSettings.activeServerId; because
 * every consumer reads getActiveServer() at use-time (agent file root, cloud
 * memory scope, deploy target, StatusBar), a reload makes the new server the
 * single source of truth across the app — the active-server cascade. Mirrors the
 * WorkspaceSwitcher pattern (DropdownMenu, active check, status dot).
 */
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { getActiveServer, renameServer, setActiveServer } from "@renderer/lib/server-registry";
import type { AppSettings } from "@renderer/lib/types";
import { Check, ChevronsUpDown, Pencil, Plus, Server, X } from "lucide-react";
import { useState } from "react";
import { AddServerDialog } from "./AddServerDialog";

export function ServerSwitcher({ settings }: { settings: AppSettings }) {
  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Optimistic name overrides so a rename shows immediately (incl. in the header
  // trigger) without a full app reload.
  const [localNames, setLocalNames] = useState<Record<string, string>>({});
  const active = getActiveServer(settings);
  if (!active) return null;

  const nameOf = (id: string, fallback: string) => localNames[id] ?? fallback;

  // Switching servers re-inits the app (AppContent re-detects context for the new
  // active server and every hook re-reads it) — the simplest correct cascade.
  async function selectServer(id: string): Promise<void> {
    if (id === active?.id) return;
    await window.api.saveSettings(setActiveServer(settings, id));
    window.location.reload();
  }

  async function commitRename(id: string): Promise<void> {
    const name = draft.trim();
    setEditingId(null);
    if (!name) return;
    setLocalNames((prev) => ({ ...prev, [id]: name }));
    await window.api.saveSettings(renameServer(settings, id, name));
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 max-w-48 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
            aria-label="Switch server"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-accent-green shadow-[0_0_6px_var(--accent-green-dim)]" />
            <Server className="size-3.5 shrink-0" />
            <span className="truncate">{nameOf(active.id, active.name)}</span>
            <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
            Servers
          </DropdownMenuLabel>
          {settings.servers.map((s) =>
            editingId === s.id ? (
              // Inline rename row (a plain div, not a menu item, so the dropdown
              // stays open while typing). Enter saves, Esc cancels.
              <div key={s.id} className="flex items-center gap-1.5 px-2 py-1.5">
                <input
                  // biome-ignore lint/a11y/noAutofocus: focus the rename field when it opens
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") void commitRename(s.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  className="min-w-0 flex-1 rounded border border-border-subtle bg-elevated px-1.5 py-1 text-xs text-text-primary outline-none"
                />
                <button type="button" onClick={() => void commitRename(s.id)} title="Save">
                  <Check className="size-3.5 text-accent-green" />
                </button>
                <button type="button" onClick={() => setEditingId(null)} title="Cancel">
                  <X className="size-3.5 text-text-dim" />
                </button>
              </div>
            ) : (
              <DropdownMenuItem
                key={s.id}
                onClick={() => void selectServer(s.id)}
                className="group gap-2"
              >
                <Check
                  className={`size-3.5 shrink-0 ${s.id === active.id ? "opacity-100" : "opacity-0"}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{nameOf(s.id, s.name)}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground/70">
                    {s.serverPath}
                  </div>
                </div>
                <button
                  type="button"
                  title="Rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDraft(nameOf(s.id, s.name));
                    setEditingId(s.id);
                  }}
                  className="shrink-0 rounded p-1 text-text-dim opacity-0 transition-opacity hover:text-text-primary group-hover:opacity-100"
                >
                  <Pencil className="size-3" />
                </button>
              </DropdownMenuItem>
            ),
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setAddOpen(true)} className="gap-2">
            <Plus className="size-3.5 shrink-0 opacity-70" />
            Add a server…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AddServerDialog settings={settings} open={addOpen} onOpenChange={setAddOpen} />
    </>
  );
}
