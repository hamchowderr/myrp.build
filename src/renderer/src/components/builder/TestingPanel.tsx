/**
 * TestingPanel (fivem-studio-ocl1) — one action: a full deploy + smoke-test
 * across EVERY built resource. Ensures all resources on the running FXServer and
 * scans the console for load errors, then shows a clean per-resource pass/fail
 * list (failed rows expand to the error + console snippet). No manual category
 * checklist — the automated full test replaces it.
 *
 * Two visual modes so there's no dead space: a centered hero before the first
 * run, and a compact header + filling results list afterwards.
 */
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import type { ServerStatus } from "@renderer/hooks/useServerStatus";
import type { SmokeAllResult, SmokeResourceResult } from "@renderer/lib/types";
import { cn } from "@renderer/lib/utils";
import { AlertTriangle, CheckCircle2, ChevronRight, FlaskConical, Loader2 } from "lucide-react";
import { useState } from "react";

function ResultRow({ r }: { r: SmokeResourceResult }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !r.ok && (!!r.loadError || (r.consoleSnippet?.length ?? 0) > 0);
  return (
    <div>
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11px] transition-colors",
          hasDetail && "hover:bg-hover",
        )}
      >
        {r.ok ? (
          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
        ) : (
          <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
        )}
        <span className={cn("flex-1 truncate", r.ok ? "text-text-secondary" : "text-text-primary")}>
          {r.resource}
        </span>
        {!r.ok && !hasDetail && <span className="text-[10px] text-text-dim">failed</span>}
        {hasDetail && (
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-text-dim transition-transform",
              open && "rotate-90",
            )}
          />
        )}
      </button>
      {open && hasDetail && (
        <div className="mb-1 ml-7 mr-2 rounded-md border border-destructive/20 bg-destructive/[0.05] px-2.5 py-2">
          {r.loadError && (
            <p className="text-[11px] leading-relaxed text-destructive/90">{r.loadError}</p>
          )}
          {r.consoleSnippet && r.consoleSnippet.length > 0 && (
            <pre className="mt-1.5 overflow-x-auto rounded bg-black/40 p-2 text-[10px] leading-relaxed text-text-muted">
              {r.consoleSnippet.join("\n")}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function TestingPanel({
  resources,
  serverStatus,
}: {
  resources: string[];
  serverStatus: ServerStatus | null;
}) {
  const [running, setRunning] = useState(false);
  const [data, setData] = useState<SmokeAllResult | null>(null);

  const online = serverStatus?.online ?? false;
  const canRun = resources.length > 0 && online && !running;

  const run = async (): Promise<void> => {
    setRunning(true);
    setData(null);
    try {
      setData(await window.api.smokeTestAll(resources));
    } catch (err) {
      setData({
        ok: false,
        results: resources.map((resource) => ({
          resource,
          ok: false,
          deployed: false,
          loadSuccess: false,
          startedConfirmed: false,
          loadError: err instanceof Error ? err.message : String(err),
          secondsWaited: 0,
        })),
      });
    } finally {
      setRunning(false);
    }
  };

  const passed = data ? data.results.filter((r) => r.ok).length : 0;
  const total = data?.results.length ?? 0;

  // Hero (pre-run) — centered, no dead space.
  if (!data && !running) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="grid size-12 place-items-center rounded-full bg-primary/10 text-primary">
          <FlaskConical className="size-5" />
        </div>
        <div className="text-[13px] font-semibold text-text-primary">Deploy &amp; smoke-test</div>
        <p className="max-w-[280px] text-[11px] leading-relaxed text-text-dim">
          {resources.length === 0
            ? "Generate a resource, then run a full deploy & smoke-test across everything built."
            : online
              ? `Ensures all ${resources.length} resources load cleanly and scans the console for errors.`
              : "Server offline — start it to run the full deploy & smoke-test."}
        </p>
        <Button size="sm" className="mt-1 h-8 gap-1.5 text-xs" disabled={!canRun} onClick={run}>
          <FlaskConical className="size-3.5" />
          Run full test
        </Button>
      </div>
    );
  }

  // Running / results — compact header + filling content.
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 py-3">
        <div className="text-[13px] font-semibold text-text-primary">Deploy &amp; smoke-test</div>
        <Button size="sm" className="h-8 shrink-0 gap-1.5 text-xs" disabled={!canRun} onClick={run}>
          {running ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <FlaskConical className="size-3.5" />
          )}
          {running ? "Testing…" : "Run again"}
        </Button>
      </div>

      {data && data.results.length > 0 && (
        <div className="shrink-0 px-4 pb-2">
          <div
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-[12px] font-medium",
              data.ok ? "bg-emerald-500/10 text-emerald-500" : "bg-destructive/10 text-destructive",
            )}
          >
            {data.ok ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
            <span>
              {passed}/{total} loaded clean
            </span>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {running ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-text-dim">
            <Loader2 className="size-5 animate-spin" />
            <p className="font-mono text-[11px]">
              Deploying &amp; testing {resources.length} resources…
            </p>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="space-y-0.5 px-2 pb-4">
              {data?.results.map((r) => (
                <ResultRow key={r.resource} r={r} />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
