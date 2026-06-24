import type {
  OrchestratorConfig,
  OrchestratorLogEntry,
  OrchestratorState,
} from "@renderer/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";

const MAX_LOG_ENTRIES = 200;

export function useOrchestrator() {
  const [state, setState] = useState<OrchestratorState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<OrchestratorLogEntry[]>([]);
  const logsRef = useRef(logs);
  logsRef.current = logs;

  // Subscribe to state changes + logs
  useEffect(() => {
    window.api
      .orchestratorGetState()
      .then(setState)
      .catch(() => {});

    const cleanupState = window.api.onOrchestratorState((newState) => {
      setState(newState);
    });

    const cleanupLog = window.api.onOrchestratorLog((entry) => {
      setLogs((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next;
      });
    });

    return () => {
      cleanupState();
      cleanupLog();
    };
  }, []);

  const startGame = useCallback(async (config: OrchestratorConfig) => {
    setError(null);
    setLogs([]);
    const result = await window.api.orchestratorStart(config);
    if (!result.ok) {
      setError(result.error ?? "Failed to start game");
    }
    return result;
  }, []);

  const stopGame = useCallback(async () => {
    setError(null);
    const result = await window.api.orchestratorStop();
    if (!result.ok) {
      setError(result.error ?? "Failed to stop game");
    }
    return result;
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  const isActive =
    state === "initializing" ||
    state === "launching" ||
    state === "waitingForGame" ||
    state === "running";

  const isLoading =
    state === "initializing" ||
    state === "launching" ||
    state === "waitingForGame" ||
    state === "stopping";

  return {
    state,
    error,
    isActive,
    isLoading,
    logs,
    clearLogs,
    startGame,
    stopGame,
  };
}
