import { getActiveServer } from "@renderer/lib/server-registry";
import { useCallback, useEffect, useRef, useState } from "react";

export interface ServerStatus {
  online: boolean;
  hostname?: string;
}

const POLL_INTERVAL = 10_000; // 10 seconds
const FAST_POLL_INTERVAL = 2_000; // 2 seconds when waiting for server to come online

export function useServerStatus(processRunning?: boolean) {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processRunningRef = useRef(processRunning);
  processRunningRef.current = processRunning;

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only self-rescheduling poll loop — re-running on status change would spawn duplicate loops
  useEffect(() => {
    cancelledRef.current = false;

    async function ping() {
      try {
        const settings = await window.api.loadSettings();
        const port = (settings && getActiveServer(settings)?.serverPort) ?? 30120;
        const result = await window.api.serverPing(port);
        if (!cancelledRef.current) setStatus(result);
      } catch {
        if (!cancelledRef.current) setStatus({ online: false });
      }
      if (!cancelledRef.current) {
        // Poll faster when process is running but HTTP endpoint isn't ready yet
        const interval =
          processRunningRef.current && !status?.online ? FAST_POLL_INTERVAL : POLL_INTERVAL;
        timerRef.current = setTimeout(ping, interval);
      }
    }

    ping();

    return () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // When process starts running, trigger an immediate ping
  const prevProcessRunning = useRef(processRunning);
  useEffect(() => {
    if (processRunning && !prevProcessRunning.current) {
      // Process just started — cancel current timer and ping immediately
      if (timerRef.current) clearTimeout(timerRef.current);
      (async () => {
        try {
          const settings = await window.api.loadSettings();
          const port = (settings && getActiveServer(settings)?.serverPort) ?? 30120;
          const result = await window.api.serverPing(port);
          if (!cancelledRef.current) setStatus(result);
        } catch {
          if (!cancelledRef.current) setStatus({ online: false });
        }
      })();
    }
    prevProcessRunning.current = processRunning;
  }, [processRunning]);

  const restartResource = useCallback(
    async (resourceName: string): Promise<{ ok: boolean; error?: string }> => {
      setIsRestarting(true);
      try {
        const settings = await window.api.loadSettings();
        const active = settings ? getActiveServer(settings) : null;
        const port = active?.serverPort ?? 30120;
        const rconPassword = active?.rconPassword ?? "";
        return await window.api.serverRestart(resourceName, port, rconPassword);
      } finally {
        setIsRestarting(false);
      }
    },
    [],
  );

  const refreshStatus = useCallback(async () => {
    try {
      const settings = await window.api.loadSettings();
      const port = (settings && getActiveServer(settings)?.serverPort) ?? 30120;
      const result = await window.api.serverPing(port);
      setStatus(result);
    } catch {
      setStatus({ online: false });
    }
  }, []);

  return { serverStatus: status, isRestarting, restartResource, refreshStatus };
}
