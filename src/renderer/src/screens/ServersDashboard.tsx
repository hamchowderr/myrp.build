/**
 * Servers dashboard — the landing surface (fivem-studio-dnx8.3).
 *
 * A card per registered server (name, live status, port, resource count, last
 * opened) with Open / Manage actions, plus an Add-server card. Every field is
 * composed live at render time from its single source — status from a port ping,
 * resources from the [local] dir, identity/port from the local registry record —
 * nothing derived is persisted. Design: design/app-shell-mockup.html (dnx8.6).
 */
import { AddServerDialog } from "@renderer/components/AddServerDialog";
import { Button } from "@renderer/components/ui/button";
import { getActiveServer } from "@renderer/lib/server-registry";
import type { AppSettings, ServerRecord } from "@renderer/lib/types";
import { Moon, Plus, Server, Settings, Sun, Terminal, Zap } from "lucide-react";
import { useEffect, useState } from "react";

function relativeTime(ts?: number): string {
  if (!ts) return "never opened";
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "opened just now";
  if (mins < 60) return `opened ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `opened ${hrs}h ago`;
  return `opened ${Math.floor(hrs / 24)}d ago`;
}

function ServerCard({
  server,
  isActive,
  onOpen,
  onManage,
  onDeploy,
}: {
  server: ServerRecord;
  isActive: boolean;
  onOpen: () => void;
  onManage: () => void;
  onDeploy: () => void;
}) {
  const [online, setOnline] = useState<boolean | null>(null);
  const [resourceCount, setResourceCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    window.api
      .serverPing(server.serverPort ?? 30120)
      .then((r) => alive && setOnline(r.online))
      .catch(() => alive && setOnline(false));
    window.api
      .listResources(server.localPath)
      .then((r) => alive && setResourceCount(r.length))
      .catch(() => alive && setResourceCount(null));
    return () => {
      alive = false;
    };
  }, [server.serverPort, server.localPath]);

  return (
    <div
      className={`flex flex-col gap-3 rounded-xl border bg-card p-4 transition-all hover:-translate-y-0.5 ${
        isActive ? "border-primary/45" : "border-border/40 hover:border-border"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`grid size-9 shrink-0 place-items-center rounded-lg ${
            isActive ? "bg-primary/15 text-primary" : "bg-muted/50 text-muted-foreground"
          }`}
        >
          <Server className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{server.name}</span>
            {isActive && (
              <span className="shrink-0 rounded-full border border-primary/45 px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-wide text-primary">
                active
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[10.5px] text-muted-foreground/70">
            {server.serverPath}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="size-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
          onClick={onManage}
          title="Manage server"
        >
          <Settings className="size-3.5" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span
            className={`size-1.5 rounded-full ${
              online == null
                ? "bg-muted-foreground/40"
                : online
                  ? "bg-accent-green shadow-[0_0_6px_var(--accent-green-dim)]"
                  : "bg-muted-foreground"
            }`}
          />
          <span className={online ? "font-medium text-accent-green" : ""}>
            {online == null ? "checking…" : online ? "Online" : "Offline"}
          </span>
        </span>
        <span className="text-muted-foreground/30">·</span>
        <span>
          port <span className="font-mono text-foreground">{server.serverPort ?? 30120}</span>
        </span>
        {resourceCount != null && (
          <>
            <span className="text-muted-foreground/30">·</span>
            <span>{resourceCount} resources</span>
          </>
        )}
        <span className="text-muted-foreground/30">·</span>
        <span>{relativeTime(server.lastOpenedAt)}</span>
      </div>

      <div className="mt-0.5 flex gap-2">
        <Button size="sm" className="flex-1" onClick={onOpen}>
          Open →
        </Button>
        <Button size="sm" variant="outline" className="flex-1 gap-1.5" onClick={onDeploy}>
          <Terminal className="size-3.5" /> Deploy
        </Button>
      </div>
    </div>
  );
}

export function ServersDashboard({
  settings,
  onOpenServer,
  onManageServer,
  onDeployServer,
  isDark,
  onToggleTheme,
}: {
  settings: AppSettings;
  onOpenServer: (id: string) => void;
  onManageServer: (id: string) => void;
  onDeployServer: (id: string) => void;
  isDark: boolean;
  onToggleTheme: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const active = getActiveServer(settings);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/40 px-4">
        <div className="flex items-center gap-1.5 font-semibold">
          <span className="grid size-5 place-items-center rounded bg-primary/15 text-primary">
            <Zap className="size-3" />
          </span>
          myRP.build
          <span className="ml-1 rounded border border-border/60 px-1.5 font-mono text-[9px] tracking-wider text-muted-foreground">
            v0.1
          </span>
        </div>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" className="size-8 p-0" onClick={onToggleTheme}>
          {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
      </header>

      <main className="flex-1 overflow-y-auto px-8 py-7">
        <div className="mb-5 flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Servers</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Your registered FiveM servers. Open one to generate resources, deploy, or manage.
            </p>
          </div>
          <Button className="gap-2" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            Add server
          </Button>
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] items-start gap-3.5">
          {settings.servers.map((s) => (
            <ServerCard
              key={s.id}
              server={s}
              isActive={s.id === active?.id}
              onOpen={() => onOpenServer(s.id)}
              onManage={() => onManageServer(s.id)}
              onDeploy={() => onDeployServer(s.id)}
            />
          ))}
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="flex min-h-[150px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
          >
            <span className="grid size-10 place-items-center rounded-full border border-border">
              <Plus className="size-5" />
            </span>
            <span className="text-sm">Add a server</span>
            <span className="text-[11px] text-muted-foreground">
              Register existing · Create new
            </span>
          </button>
        </div>
      </main>

      <AddServerDialog settings={settings} open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
