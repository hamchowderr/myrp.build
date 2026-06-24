import { useCallback, useEffect, useState } from "react";

export interface ServerProcessStatus {
  running: boolean;
  pid?: number;
  lastChecked: Date;
}

export function useServerProcess() {
  const [processStatus, setProcessStatus] = useState<ServerProcessStatus | null>(null);

  const check = useCallback(async () => {
    try {
      const result = await window.api.checkServerProcess();
      setProcessStatus({ ...result, lastChecked: new Date() });
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    check(); // immediate check
    const interval = setInterval(check, 10_000); // poll every 10s
    return () => clearInterval(interval);
  }, [check]);

  return { processStatus, refresh: check };
}
