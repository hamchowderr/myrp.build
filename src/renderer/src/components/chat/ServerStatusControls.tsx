/**
 * Live server status + quota for the top header (the Foreman-style "status up
 * top, clean bottom" layout). Holds what used to live in the fixed bottom
 * StatusBar — generations left, framework, FXServer process + start/stop/restart,
 * and online/offline + refresh — as a calm, well-spaced cluster (one divider, no
 * busy line-grid). The server path isn't shown here: it already lives in the
 * ServerSwitcher dropdown.
 */
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import type { ServerProcessStatus } from "@renderer/hooks/useServerProcess";
import type { ServerStatus } from "@renderer/hooks/useServerStatus";
import type { Plan } from "@renderer/lib/account";
import { cn } from "@renderer/lib/utils";
import { Circle, Play, RotateCcw, Square, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";

interface ServerStatusControlsProps {
  framework: string;
  canUndo: boolean;
  onUndo?: () => void;
  serverStatus?: ServerStatus | null;
  processStatus?: ServerProcessStatus | null;
  onStartServer?: () => void;
  onStopServer?: () => void;
  onRestartServer?: () => void;
  isRestartingServer?: boolean;
  plan?: Plan;
  usageCount?: number;
  usageLimit?: number;
  onUpgrade?: () => void;
}

export function ServerStatusControls({
  framework,
  canUndo,
  onUndo,
  serverStatus,
  processStatus,
  onStartServer,
  onStopServer,
  onRestartServer,
  isRestartingServer,
  plan,
  usageCount,
  usageLimit,
  onUpgrade,
}: ServerStatusControlsProps) {
  const running = processStatus?.running;
  const isOnline = serverStatus?.online;
  const isStarting = running && !isOnline;

  // The whole-server Restart is a txAdmin-only control. A direct-launched FXServer
  // has no txAdmin, so show Restart only when txAdmin is actually reachable —
  // otherwise it dead-ends on ERR_CONNECTION_REFUSED (fivem-studio-92fh).
  const [txAvailable, setTxAvailable] = useState(false);
  useEffect(() => {
    if (!running) {
      setTxAvailable(false);
      return;
    }
    let cancelled = false;
    void window.api.txadmin.isAvailable().then((r) => {
      if (!cancelled) setTxAvailable(r.available);
    });
    return () => {
      cancelled = true;
    };
  }, [running]);

  return (
    <div className="flex items-center gap-3 font-mono text-[11px] text-text-muted">
      {/* Generations left this month (dev-bypass is unlimited → "Unlimited"). */}
      {plan &&
        (() => {
          const limit = usageLimit ?? 10;
          const used = usageCount ?? 0;
          const unlimited = !Number.isFinite(limit);
          const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
          return (
            <button
              type="button"
              onClick={onUpgrade}
              title={
                unlimited
                  ? `${planLabel} plan — unlimited generations`
                  : `${planLabel} plan — ${used}/${limit} generations used this month`
              }
              className="group flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-hover"
            >
              <span className="text-text-secondary">
                {plan !== "free" && <span className="text-text-dim">{planLabel} · </span>}
                {unlimited ? (
                  "Unlimited"
                ) : (
                  <>
                    <span className="text-text-primary">{Math.max(0, limit - used)}</span> left
                  </>
                )}
              </span>
              {plan === "free" && (
                <span className="text-text-dim transition-colors group-hover:text-primary">
                  Upgrade
                </span>
              )}
            </button>
          );
        })()}

      {canUndo && onUndo && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px] text-text-muted hover:text-text-primary"
          onClick={onUndo}
        >
          <Undo2 className="size-3" />
          Undo
        </Button>
      )}

      <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px] font-normal">
        {framework === "unknown" ? "vanilla" : framework}
      </Badge>

      {/* The single divider: build/account info | live server status. */}
      <div className="h-3.5 w-px bg-border-subtle" />

      {/* FXServer process + lifecycle controls */}
      <div className="flex items-center gap-1.5" data-tour-step-id="server-status">
        <Circle
          className={cn(
            "size-1.5 shrink-0",
            running ? "fill-accent-green text-accent-green" : "fill-text-dim/40 text-text-dim/40",
          )}
        />
        <span>{running ? "FXServer" : "stopped"}</span>
        {running ? (
          <>
            <button
              type="button"
              onClick={onStopServer}
              title="Stop FXServer"
              className="rounded p-1 text-text-dim transition-colors hover:text-accent-red"
            >
              <Square className="size-2.5 fill-current" />
            </button>
            {onRestartServer && txAvailable && (
              <button
                type="button"
                onClick={onRestartServer}
                disabled={isRestartingServer}
                title="Restart FXServer (txAdmin)"
                className="rounded p-1 text-text-dim transition-colors hover:text-primary disabled:opacity-50"
              >
                <RotateCcw className={cn("size-2.5", isRestartingServer && "animate-spin")} />
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={onStartServer}
            title="Start FXServer"
            className="rounded p-1 text-text-dim transition-colors hover:text-accent-green"
          >
            <Play className="size-2.5 fill-current" />
          </button>
        )}
      </div>

      {/* Server online / offline */}
      <div className="flex items-center gap-1.5">
        <div className="relative">
          <Circle
            className={cn(
              "size-1.5 shrink-0",
              isOnline
                ? "fill-accent-green text-accent-green"
                : isStarting
                  ? "fill-amber-500 text-amber-500"
                  : "fill-text-dim/40 text-text-dim/40",
            )}
          />
          {isStarting && (
            <div className="absolute inset-0 animate-ping rounded-full bg-amber-500/40" />
          )}
        </div>
        <span className="max-w-40 truncate">
          {isOnline ? (serverStatus.hostname ?? "online") : isStarting ? "starting…" : "offline"}
        </span>
      </div>
    </div>
  );
}
