import type {
  GameFrameMessage,
  GameViewCapabilities,
  GameViewStartOptions,
  GameViewStats,
} from "@renderer/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";

export function useGameView() {
  const [isCapturing, setIsCapturing] = useState(false);
  const [lastFrame, setLastFrame] = useState<GameFrameMessage | null>(null);
  const [stats, setStats] = useState<GameViewStats | null>(null);
  const [capabilities, setCapabilities] = useState<GameViewCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const statsInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  // Detect capabilities on mount
  useEffect(() => {
    window.api
      .gameviewCapabilities()
      .then(setCapabilities)
      .catch(() => {});
  }, []);

  // Subscribe to frame stream when capturing
  useEffect(() => {
    if (!isCapturing) return;

    const cleanup = window.api.onGameFrame((frame: GameFrameMessage) => {
      setLastFrame(frame);
    });

    // Poll stats every second while capturing
    statsInterval.current = setInterval(() => {
      window.api
        .gameviewStats()
        .then(setStats)
        .catch(() => {});
    }, 1000);

    return () => {
      cleanup();
      if (statsInterval.current) {
        clearInterval(statsInterval.current);
        statsInterval.current = null;
      }
    };
  }, [isCapturing]);

  const start = useCallback(async (options?: GameViewStartOptions) => {
    setError(null);
    const result = await window.api.gameviewStart(options);
    if (result.ok) {
      setIsCapturing(true);
    } else {
      setError(result.error ?? "Failed to start capture");
    }
    return result;
  }, []);

  const stop = useCallback(async () => {
    await window.api.gameviewStop();
    setIsCapturing(false);
    setLastFrame(null);
    setStats(null);
  }, []);

  return { isCapturing, lastFrame, stats, capabilities, error, start, stop };
}
