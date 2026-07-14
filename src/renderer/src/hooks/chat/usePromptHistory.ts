import type { PromptHistoryEntry } from "@renderer/lib/types";
import { useCallback, useRef, useState } from "react";

const HISTORY_KEY = "myrp-build-prompt-history";
const HISTORY_MAX = 20;

function loadHistory(): PromptHistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as PromptHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: PromptHistoryEntry[]): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
}

export interface UsePromptHistoryReturn {
  promptHistory: PromptHistoryEntry[];
  lastPromptRef: React.RefObject<string>;
  addToHistory: (prompt: string) => void;
  updateHistoryResourceName: (prompt: string, resourceName: string) => void;
  clearHistory: () => void;
}

export function usePromptHistory(): UsePromptHistoryReturn {
  const [promptHistory, setPromptHistory] = useState<PromptHistoryEntry[]>(loadHistory);
  const lastPromptRef = useRef<string>("");

  const addToHistory = useCallback((prompt: string) => {
    lastPromptRef.current = prompt;
    setPromptHistory((prev) => {
      const filtered = prev.filter((e) => e.prompt !== prompt);
      const entry: PromptHistoryEntry = {
        id: `hist-${Date.now()}`,
        prompt,
        timestamp: new Date().toISOString(),
      };
      const updated = [entry, ...filtered].slice(0, HISTORY_MAX);
      saveHistory(updated);
      return updated;
    });
  }, []);

  const updateHistoryResourceName = useCallback((prompt: string, resourceName: string) => {
    setPromptHistory((prev) => {
      const updated = prev.map((entry) =>
        entry.prompt === prompt && !entry.resourceName ? { ...entry, resourceName } : entry,
      );
      saveHistory(updated);
      return updated;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setPromptHistory([]);
    saveHistory([]);
  }, []);

  return {
    promptHistory,
    lastPromptRef,
    addToHistory,
    updateHistoryResourceName,
    clearHistory,
  };
}
