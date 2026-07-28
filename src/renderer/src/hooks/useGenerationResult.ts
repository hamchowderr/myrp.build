/**
 * The generation RESULT: the manifest a finished turn produced, and undo.
 *
 * Extracted from the retired `useAEChat`. That hook bundled two unrelated
 * things — an `@ai-sdk/react` chat over the legacy `chat:chunk` transport, and
 * this result state. The transport half died when generation moved to the agent
 * controller (main emits `harness:event` now, never `chat:chunk`), but the
 * result half never did: `chat:result` is still sent by `finalizeGeneration`
 * once a turn writes files, and the ArtifactPanel depends on it.
 *
 * Deliberately NOT part of the chat transcript. A result outlives the turn that
 * produced it — it stays on screen (with its undo) while the next turn streams —
 * so folding it into the harness transcript would clear it too early.
 */
import type { GenerationResult } from "@renderer/lib/types";
import { useCallback, useEffect, useState } from "react";

export interface UseGenerationResult {
  /** The last finished generation's manifest, or null before the first one. */
  result: GenerationResult | null;
  /** True when there is a manifest to roll back. */
  canUndo: boolean;
  /** Roll the generation back on disk and drop it from the panel. */
  undo: () => Promise<void>;
  /** Forget the current result without touching disk (e.g. the user deleted it). */
  clearResult: () => void;
  /** Notified on every new result — the sidebar uses it as a refresh signal. */
  resultCount: number;
}

export function useGenerationResult(): UseGenerationResult {
  const [result, setResult] = useState<GenerationResult | null>(null);
  // Monotonic: a NEW result must re-trigger the sidebar refresh even when it has
  // the same resource name as the last one, which a value-compare would swallow.
  const [resultCount, setResultCount] = useState(0);

  useEffect(
    () =>
      window.api.chat.onResult((r) => {
        setResult(r);
        setResultCount((n) => n + 1);
      }),
    [],
  );

  const undo = useCallback(async () => {
    if (!result?.manifestPath) return;
    await window.api.undoGeneration(result.manifestPath);
    setResult(null);
  }, [result]);

  return {
    result,
    canUndo: !!result?.manifestPath,
    undo,
    clearResult: () => setResult(null),
    resultCount,
  };
}
