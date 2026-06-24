/**
 * Deploy / monitor panel (fivem-studio-dnx8.5).
 *
 * Per-server control surface over the txAdmin/RCON work (e4c/dt2): live status,
 * server start/stop/restart, per-resource start/stop/restart toggles, and the
 * live server console. Composes existing hooks/IPC (useServerProcess,
 * useServerStatus, useServerConsole, useFileTree.controlResource,
 * window.api.txadmin.control) — no new main-process surface.
 */
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { useFileTree } from "@renderer/hooks/useFileTree";
import { useServerConsole } from "@renderer/hooks/useServerConsole";
import { useServerProcess } from "@renderer/hooks/useServerProcess";
import { useServerStatus } from "@renderer/hooks/useServerStatus";
import { getActiveServer } from "@renderer/lib/server-registry";
import type { AppSettings, SmokeResourceResult } from "@renderer/lib/types";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FlaskConical,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export function DeployMonitor({ settings, onBack }: { settings: AppSettings; onBack: () => void }) {
  const active = getActiveServer(settings);
  const localPath = active?.localPath ?? "";
  const { processStatus, refresh: refreshProcess } = useServerProcess();
  const { serverStatus, refreshStatus } = useServerStatus(processStatus?.running);
  const { entries, clear } = useServerConsole();
  const tree = useFileTree(localPath, null);
  const [busy, setBusy] = useState<null | "start" | "stop" | "restart">(null);
  const [err, setErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<Map<string, SmokeResourceResult> | null>(null);

  async function runFullTest() {
    if (tree.serverResources.length === 0) return;
    setTesting(true);
    try {
      const data = await window.api.smokeTestAll(tree.serverResources);
      setTestResults(new Map(data.results.map((r) => [r.resource, r])));
      const passed = data.results.filter((r) => r.ok).length;
      if (data.ok) {
        toast.success(`All ${passed} resources loaded clean`);
      } else {
        toast.error(
          `${passed}/${data.results.length} loaded clean — ${data.results.length - passed} failed`,
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Smoke test failed");
    } finally {
      setTesting(false);
    }
  }

  const online = serverStatus?.online ?? false;
  const running = processStatus?.running ?? false;

  async function serverAction(action: "start" | "stop" | "restart") {
    setBusy(action);
    setErr(null);
    try {
      const r =
        action === "start"
          ? await window.api.startServer()
          : action === "stop"
            ? await window.api.stopServer()
            : await window.api.txadmin.control("restart");
      if (!r.ok) setErr(r.error ?? `Failed to ${action} server`);
      setTimeout(() => {
        refreshProcess();
        refreshStatus();
      }, 1500);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/40 px-4">
        <Button variant="ghost" size="sm" className="size-8 p-0" onClick={onBack} title="Back">
          <ArrowLeft className="size-4" />
        </Button>
        <Terminal className="size-4 text-muted-foreground" />
        <span className="font-semibold">Deploy &amp; Monitor</span>
        {active && (
          <span className="font-mono text-[11px] text-muted-foreground">· {active.name}</span>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        {/* Status + server controls */}
        <div className="flex items-center justify-between rounded-xl border border-border/40 bg-card p-4">
          <div className="flex items-center gap-5 text-sm">
            <span className="flex items-center gap-2">
              <span
                className={`size-2 rounded-full ${online ? "bg-accent-green shadow-[0_0_6px_var(--accent-green-dim)]" : "bg-muted-foreground"}`}
              />
              <span
                className={online ? "font-semibold text-accent-green" : "text-muted-foreground"}
              >
                {online ? "Online" : "Offline"}
              </span>
            </span>
            <span className="text-muted-foreground">
              process <span className="text-foreground">{running ? "running" : "stopped"}</span>
            </span>
            <span className="text-muted-foreground">
              port <span className="font-mono text-foreground">{active?.serverPort ?? 30120}</span>
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="gap-1.5"
              disabled={busy != null}
              onClick={() => serverAction("start")}
            >
              {busy === "start" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              Start
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={busy != null}
              onClick={() => serverAction("restart")}
            >
              {busy === "restart" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              Restart
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-destructive"
              disabled={busy != null}
              onClick={() => serverAction("stop")}
            >
              {busy === "stop" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Square className="size-3.5" />
              )}
              Stop
            </Button>
          </div>
        </div>
        {err && <p className="text-xs text-destructive">{err}</p>}

        <div className="flex min-h-0 flex-1 gap-4">
          {/* Resources */}
          <div className="flex w-72 shrink-0 flex-col rounded-xl border border-border/40 bg-card">
            <div className="flex items-center justify-between border-border/40 border-b px-3 py-2">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Resources
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1.5 px-2 text-xs"
                disabled={!online || testing || tree.serverResources.length === 0}
                onClick={runFullTest}
                title={online ? "Deploy & smoke-test every resource" : "Server offline"}
              >
                {testing ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <FlaskConical className="size-3" />
                )}
                Test all
              </Button>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-2">
                {tree.serverResources.map((name) => (
                  <div
                    key={name}
                    className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-muted/40"
                  >
                    {(() => {
                      const tr = testResults?.get(name);
                      if (!tr) return null;
                      return tr.ok ? (
                        <CheckCircle2 className="size-3 shrink-0 text-emerald-500" />
                      ) : (
                        <AlertTriangle
                          className="size-3 shrink-0 text-destructive"
                          aria-label={tr.loadError ?? "failed"}
                        />
                      );
                    })()}
                    <span className="flex-1 truncate text-xs">{name}</span>
                    {(["restart", "stop", "start"] as const).map((act) => (
                      <button
                        type="button"
                        key={act}
                        title={`${act} ${name}`}
                        disabled={tree.controlling?.name === name}
                        onClick={() => tree.controlResource(name, act)}
                        className="grid size-6 place-items-center rounded text-muted-foreground hover:text-foreground disabled:opacity-40"
                      >
                        {tree.controlling?.name === name && tree.controlling.action === act ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : act === "restart" ? (
                          <RotateCcw className="size-3" />
                        ) : act === "stop" ? (
                          <Square className="size-3" />
                        ) : (
                          <Play className="size-3" />
                        )}
                      </button>
                    ))}
                  </div>
                ))}
                {tree.serverResources.length === 0 && (
                  <p className="p-2 text-xs text-muted-foreground">No resources.</p>
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Console */}
          <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-border/40 bg-card">
            <div className="flex items-center justify-between border-border/40 border-b px-3 py-2">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Console
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1.5 px-2 text-xs"
                onClick={clear}
              >
                <Trash2 className="size-3" /> Clear
              </Button>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-3 font-mono text-[11px] leading-relaxed">
                {entries.length === 0 ? (
                  <p className="text-muted-foreground">
                    No console output. Start the server to stream logs.
                  </p>
                ) : (
                  entries.map((e) => (
                    <div
                      key={e.id}
                      className={
                        e.source === "stderr"
                          ? "text-destructive"
                          : e.source === "system"
                            ? "text-accent-cyan"
                            : "text-foreground/80"
                      }
                    >
                      {e.text}
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </div>
    </div>
  );
}
