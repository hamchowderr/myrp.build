import { Button } from "@renderer/components/ui/button";
import { useGameView } from "@renderer/hooks/useGameView";
import { useOrchestrator } from "@renderer/hooks/useOrchestrator";
import type { OrchestratorLogEntry } from "@renderer/lib/types";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Gamepad2,
  Loader2,
  Monitor,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

const STATE_LABELS: Record<string, string> = {
  idle: "Idle",
  initializing: "Setting up shared memory…",
  launching: "Launching FiveM…",
  waitingForGame: "Waiting for game init…",
  running: "Game running",
  stopping: "Stopping…",
  error: "Error",
};

const LOG_LEVEL_COLORS: Record<string, string> = {
  info: "text-text-dim",
  warn: "text-amber-400",
  error: "text-red-400",
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function LogLine({ entry }: { entry: OrchestratorLogEntry }) {
  return (
    <div className="flex gap-2 px-2 py-px font-mono text-[10px] leading-4 hover:bg-white/[0.02]">
      <span className="shrink-0 text-text-dim/50">{formatTime(entry.timestamp)}</span>
      <span className={`shrink-0 w-9 ${LOG_LEVEL_COLORS[entry.level] ?? "text-text-dim"}`}>
        {entry.level}
      </span>
      <span className={LOG_LEVEL_COLORS[entry.level] ?? "text-text-dim"}>{entry.message}</span>
    </div>
  );
}

export function GameViewPanel() {
  const { isCapturing, lastFrame, stats, capabilities, error, start, stop } = useGameView();
  const orchestrator = useOrchestrator();
  const [testMode, setTestMode] = useState(true);
  const [logOpen, setLogOpen] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs
  useEffect(() => {
    if (logOpen && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logOpen]);

  const handleStart = () => {
    if (testMode) {
      start({ testMode: true, targetFps: 10, width: 1280, height: 720 });
    } else {
      orchestrator.startGame({
        fivemExePath: "",
        width: 1280,
        height: 720,
      });
    }
  };

  const handleStop = () => {
    if (testMode || !orchestrator.isActive) {
      stop();
    } else {
      orchestrator.stopGame();
    }
  };

  const isActive = isCapturing || orchestrator.isActive;
  const combinedError = error || orchestrator.error;
  const hasLogs = orchestrator.logs.length > 0;

  return (
    <div className="flex h-full flex-col bg-black">
      {/* Top bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-elevated px-3 py-1.5">
        {isActive ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 font-mono text-[10px] text-red-400 hover:text-red-300"
            onClick={handleStop}
            disabled={orchestrator.state === "stopping"}
          >
            <Square className="size-3" />
            Stop
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 font-mono text-[10px] text-accent-green hover:text-accent-green"
            onClick={handleStart}
          >
            <Play className="size-3" />
            {testMode ? "Start" : "Start Game"}
          </Button>
        )}

        <label className="flex items-center gap-1.5 font-mono text-[10px] text-text-dim">
          <input
            type="checkbox"
            checked={testMode}
            onChange={(e) => setTestMode(e.target.checked)}
            disabled={isActive}
            className="accent-accent-blue"
          />
          Test Mode
        </label>

        <div className="flex-1" />

        {/* Orchestrator state indicator */}
        {orchestrator.isActive && (
          <span className="flex items-center gap-1 rounded-sm bg-amber-500/15 px-1.5 py-0.5 font-mono text-[9px] text-amber-400">
            {orchestrator.isLoading && <Loader2 className="size-2.5 animate-spin" />}
            {orchestrator.state === "running" && <Gamepad2 className="size-2.5" />}
            {STATE_LABELS[orchestrator.state] ?? orchestrator.state}
          </span>
        )}

        {stats && isCapturing && (
          <>
            <span className="rounded-sm bg-accent-blue/15 px-1.5 py-0.5 font-mono text-[9px] font-medium text-accent-blue">
              {stats.fps} FPS
            </span>
            <span className="rounded-sm bg-surface-alt px-1.5 py-0.5 font-mono text-[9px] text-text-dim">
              {stats.backend}
            </span>
            {stats.droppedFrames > 0 && (
              <span className="rounded-sm bg-red-500/15 px-1.5 py-0.5 font-mono text-[9px] text-red-400">
                {stats.droppedFrames} dropped
              </span>
            )}
          </>
        )}
      </div>

      {/* Frame display */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {lastFrame ? (
          <img
            src={`data:image/jpeg;base64,${lastFrame.jpeg}`}
            alt="Game frame"
            className="max-h-full max-w-full object-contain"
            draggable={false}
          />
        ) : (
          <div className="text-center font-mono text-xs text-text-dim">
            {combinedError ? (
              <div className="space-y-2">
                <AlertCircle className="mx-auto size-8 text-red-400 opacity-50" />
                <p className="max-w-xs text-red-400">{combinedError}</p>
              </div>
            ) : orchestrator.isLoading ? (
              <div className="space-y-3">
                <Loader2 className="mx-auto size-8 animate-spin opacity-40" />
                <p>{STATE_LABELS[orchestrator.state] ?? "Loading…"}</p>
              </div>
            ) : (
              <div className="space-y-2">
                <Monitor className="mx-auto size-8 opacity-30" />
                <p>
                  {testMode ? "Click Start for test pattern" : "Click Start Game to launch FiveM"}
                </p>
                {capabilities && (
                  <div className="mt-3 space-y-1 text-[10px] text-text-dim/60">
                    <p>CPU capture: {capabilities.cpuAvailable ? "available" : "unavailable"}</p>
                    <p>GPU capture: {capabilities.gpuAvailable ? "available" : "unavailable"}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Log panel */}
      {(hasLogs || orchestrator.isActive) && (
        <div className="shrink-0 border-t border-border-subtle">
          {/* Log header */}
          <button
            type="button"
            className="flex w-full items-center gap-2 bg-elevated px-3 py-1 text-left"
            onClick={() => setLogOpen((v) => !v)}
          >
            {logOpen ? (
              <ChevronDown className="size-3 text-text-dim" />
            ) : (
              <ChevronUp className="size-3 text-text-dim" />
            )}
            <span className="font-mono text-[10px] font-medium text-text-dim">
              Orchestrator Log
            </span>
            <span className="font-mono text-[9px] text-text-dim/50">
              {orchestrator.logs.length}
            </span>
            <div className="flex-1" />
            {hasLogs && (
              // biome-ignore lint/a11y/useSemanticElements: nested inside a <button>; a real <button> can't legally nest — span+role+keydown is the accessible alternative
              <span
                role="button"
                tabIndex={0}
                className="text-text-dim/40 hover:text-text-dim"
                onClick={(e) => {
                  e.stopPropagation();
                  orchestrator.clearLogs();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation();
                    orchestrator.clearLogs();
                  }
                }}
              >
                <Trash2 className="size-3" />
              </span>
            )}
          </button>

          {/* Log entries */}
          {logOpen && (
            <div className="max-h-36 overflow-y-auto bg-black/80 py-1">
              {orchestrator.logs.length === 0 ? (
                <p className="px-2 py-1 font-mono text-[10px] text-text-dim/40">
                  Waiting for logs…
                </p>
              ) : (
                orchestrator.logs.map((entry, i) => (
                  <LogLine key={`${entry.timestamp}-${i}`} entry={entry} />
                ))
              )}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
