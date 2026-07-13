/**
 * Harness chat transport hook — the IPC adaptation of
 * mastra-chat-kit's `useHarnessChat`. The kit reads a `data:`-framed SSE; here
 * the main process forwards each raw AgentControllerEvent (plus the __thread__ /
 * __done__ sentinels) over IPC via `window.api.harness.onEvent`, and we fold
 * them through the SAME pure `reduceHarnessEvent` reducer into a transcript the
 * AI Elements render.
 *
 * Mirrors useChat's shape (`{ messages, status, sendMessage }`) so the Generator
 * can swap transports behind the default-OFF useHarness flag (window.api.harness
 * .isEnabled()). The main `chat:start` handler branches on the same flag, so
 * `start` here invokes it and the events arrive on `harness:event`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  emptyTranscript,
  type HarnessMessage,
  type HarnessTranscript,
  OPTIMISTIC_USER_ID,
  reduceHarnessEvent,
  uiMessagesToHarness,
} from "./events";

export type HarnessStatus = "ready" | "streaming" | "error";

/** Per-turn auth/model the main process needs (same fields as the useChat path). */
export interface HarnessSendExtra {
  model?: string;
  accessToken?: string;
  workspaceId?: string;
  /**
   * Resolve the Supabase access token lazily. When provided (and `accessToken`
   * isn't), the optimistic user message + streaming state render BEFORE this
   * token round-trip resolves, so a suggestion click is instant.
   */
  getAccessToken?: () => Promise<string | undefined>;
}

export interface UseHarnessChat {
  transcript: HarnessTranscript;
  messages: HarnessMessage[];
  status: HarnessStatus;
  /** The active thread id (null until the Harness reports one). */
  threadId: string | null;
  /** Send a user turn. Memory carries prior turns on the thread server-side. */
  sendMessage: (text: string, extra?: HarnessSendExtra) => Promise<void>;
  /** Answer a parked tool-approval gate. */
  approve: (
    decision: "approve" | "decline" | "always_allow_category",
    toolCallId?: string,
  ) => Promise<void>;
  /** Answer a parked ask_user / submit_plan suspension — resumes the same run. */
  respondSuspension: (answer: unknown, toolCallId?: string) => Promise<void>;
  /** Abort the in-flight run. */
  cancel: () => Promise<void>;
  /** Load a past conversation's history into the view. */
  openThread: (
    threadId: string,
    extra?: { accessToken?: string; workspaceId?: string },
  ) => Promise<void>;
  /** Clear the transcript and start a brand-new conversation. */
  reset: () => void;
}

/**
 * Subscribe to the Harness event stream and expose a useChat-shaped transport.
 * One persistent IPC subscription for the component's lifetime; every event is
 * folded into the transcript. `__done__` returns status to `ready`; an `error`
 * event flips to `error`.
 */
export function useHarnessChat(): UseHarnessChat {
  const [transcript, setTranscript] = useState<HarnessTranscript>(emptyTranscript);
  const [status, setStatus] = useState<HarnessStatus>("ready");
  // Always-current thread id for follow-up turns (the reducer also tracks it in
  // transcript.threadId, but a ref avoids a stale closure in sendMessage).
  const threadRef = useRef<string | null>(null);

  useEffect(() => {
    const off = window.api?.harness?.onEvent((event) => {
      if (event.type === "__thread__" && typeof event.threadId === "string") {
        threadRef.current = event.threadId;
      }
      if (event.type === "__done__") setStatus("ready");
      // Parked on ask_user: the run is idle awaiting the answer — return to `ready`
      // (drop the spinner) but keep the suspension card (the reducer preserves it).
      if (event.type === "__suspended__") setStatus("ready");
      if (event.type === "error") setStatus("error");
      setTranscript((s) => reduceHarnessEvent(s, event));
    });
    return off;
  }, []);

  const sendMessage = useCallback(async (text: string, extra?: HarnessSendExtra) => {
    if (!text.trim()) return;
    // Optimistic user message — render the sent text + spinner INSTANTLY, before
    // the token round-trip or the IPC call, so a suggestion click feels immediate.
    // The Harness later echoes the user turn (role=user, its own id) and the
    // reducer swaps this placeholder for it by id, so it never shows twice.
    setTranscript((s) => ({
      ...s,
      error: null,
      done: false,
      // A new turn invalidates the prior turn's feedback target (parity with AEChat).
      lastGenerationId: null,
      // …and its RAG citations (this turn retrieves its own).
      sources: [],
      messages: [
        ...s.messages.filter((m) => m.id !== OPTIMISTIC_USER_ID),
        { id: OPTIMISTIC_USER_ID, role: "user", content: [{ type: "text", text }] },
      ],
    }));
    setStatus("streaming");
    try {
      // Resolve the token lazily (after the optimistic render) so it never gates
      // the first paint. accessToken takes precedence when a caller pre-resolved it.
      const accessToken =
        extra?.accessToken ?? (extra?.getAccessToken ? await extra.getAccessToken() : undefined);
      await window.api.harness.start({
        text,
        // "" → the main branch starts a fresh thread (the Harness mints the id).
        chatId: threadRef.current ?? "",
        ...(extra?.model ? { model: extra.model } : {}),
        ...(accessToken ? { accessToken } : {}),
        ...(extra?.workspaceId ? { workspaceId: extra.workspaceId } : {}),
      });
    } catch (err) {
      setTranscript((s) => ({
        ...s,
        error: err instanceof Error ? err.message : String(err),
      }));
      setStatus("error");
    }
  }, []);

  const approve = useCallback(
    async (decision: "approve" | "decline" | "always_allow_category", toolCallId?: string) => {
      await window.api.harness.approve(decision, toolCallId);
    },
    [],
  );

  const respondSuspension = useCallback(async (answer: unknown, toolCallId?: string) => {
    setTranscript((s) => ({ ...s, error: null, done: false }));
    setStatus("streaming");
    try {
      await window.api.harness.respondSuspension(answer, toolCallId);
    } catch (err) {
      setTranscript((s) => ({
        ...s,
        error: err instanceof Error ? err.message : String(err),
      }));
      setStatus("error");
    }
  }, []);

  const cancel = useCallback(async () => {
    await window.api.harness.cancel();
    setStatus("ready");
  }, []);

  const openThread = useCallback(
    async (threadId: string, extra?: { accessToken?: string; workspaceId?: string }) => {
      const res = await window.api.chat.loadThread({
        threadId,
        ...(extra?.accessToken ? { accessToken: extra.accessToken } : {}),
        ...(extra?.workspaceId ? { workspaceId: extra.workspaceId } : {}),
      });
      if (!res.ok) {
        setTranscript((s) => ({ ...s, error: res.error ?? "Couldn't open this conversation." }));
        setStatus("error");
        return;
      }
      threadRef.current = threadId;
      setStatus("ready");
      // Seed a fresh transcript from the loaded history; follow-up turns continue
      // this thread (threadRef) so memory carries context.
      setTranscript({
        ...emptyTranscript(),
        threadId,
        messages: uiMessagesToHarness(res.messages ?? []),
      });
    },
    [],
  );

  const reset = useCallback(() => {
    threadRef.current = null;
    setTranscript(emptyTranscript());
    setStatus("ready");
  }, []);

  return {
    transcript,
    messages: transcript.messages,
    status,
    threadId: transcript.threadId,
    sendMessage,
    approve,
    respondSuspension,
    cancel,
    openThread,
    reset,
  };
}
