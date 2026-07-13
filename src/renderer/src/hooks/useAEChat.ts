/**
 * Chat state for the AI-Elements generation UI. Lifts useChat
 * (over the IPC ChatTransport) plus prompt history and the generation result so
 * the Generator can share it across AEChat, HeaderBar, StatusBar and the right
 * panel. Replaces the legacy useGeneratorChat (StreamMessage pipeline).
 */

import { useChat } from "@ai-sdk/react";
import { useAccount } from "@renderer/lib/account";
import { classifyApprovalIntent } from "@renderer/lib/approval-intent";
import { IpcChatTransport } from "@renderer/lib/ipc-chat-transport";
import type { GenerationResult } from "@renderer/lib/types";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePromptHistory } from "./chat/usePromptHistory";

const transport = new IpcChatTransport();

export interface UseAEChatReturn {
  messages: UIMessage[];
  isGenerating: boolean;
  status: string;
  result: GenerationResult | null;
  /** Id of the just-completed generation (for thumbs up/down feedback). */
  lastGenerationId: string | null;
  canUndo: boolean;
  /** A gated tool is paused awaiting approval — a typed reply approves/declines it. */
  awaitingApproval: boolean;
  /** Last upstream error (out-of-credits / bad key / rate-limit), shown in the chat; null when clear. */
  error: string | null;
  /** Model-generated follow-up suggestions for the just-finished turn. */
  followups: string[];
  promptHistory: import("@renderer/lib/types").PromptHistoryEntry[];
  send: (text: string, model?: string) => void;
  cancel: () => void;
  clearHistory: () => void;
  newSession: () => void;
  /** Branch the current thread into a new one seeded with its messages. */
  clone: () => Promise<void>;
  /** The current session/thread id (= useChat id = Mastra thread). */
  sessionId: string;
  /** Open a persisted conversation by id, seeding the UI with its history. */
  openThread: (threadId: string) => Promise<void>;
  undo: () => Promise<void>;
  clearResult: () => void;
}

export function useAEChat(): UseAEChatReturn {
  // sessionId == useChat id == Mastra memory thread. A new session gets a fresh
  // id so follow-up context doesn't bleed across generations.
  const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID());
  const { messages, sendMessage, status, stop, setMessages } = useChat({
    id: sessionId,
    transport,
  });
  // Messages to seed into the NEXT chat instance after a clone switches sessionId.
  // Applied in an effect once useChat has re-mounted under the new id.
  const [pendingSeed, setPendingSeed] = useState<UIMessage[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed exactly once when sessionId changes to the cloned id
  useEffect(() => {
    if (pendingSeed) {
      setMessages(pendingSeed);
      setPendingSeed(null);
    }
  }, [sessionId]);
  const { promptHistory, addToHistory, updateHistoryResourceName, clearHistory } =
    usePromptHistory();
  // Supabase access token for the prod inference proxy; resolves null in dev-bypass.
  // canGenerate/isDev gate generation on the monthly quota (always allowed in dev).
  const { getToken, canGenerate, isDev, workspaceId } = useAccount();
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [lastPrompt, setLastPrompt] = useState("");
  const [lastGenerationId, setLastGenerationId] = useState<string | null>(null);
  // A gated tool paused mid-stream awaiting approval. Mirrored to a ref
  // so `send` reads the live value without being recreated each pause.
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const awaitingApprovalRef = useRef(false);
  const setAwaiting = useCallback((v: boolean) => {
    awaitingApprovalRef.current = v;
    setAwaitingApproval(v);
  }, []);
  // Last upstream LLM error, surfaced in the chat (was previously swallowed).
  const [error, setError] = useState<string | null>(null);
  // Dynamic follow-up suggestions for the last finished turn. A req-id
  // guards against a stale response from a prior turn clobbering a newer one.
  const [followups, setFollowups] = useState<string[]>([]);
  const followupReq = useRef(0);

  const isGenerating = status === "submitted" || status === "streaming";

  // Main pauses the stream and emits chat:approval_pending when a gated tool
  // (execute_command / delete / deploy_resource) needs sign-off. The original
  // chat:start stream stays open, so resolving via chat.approve resumes it in
  // place — no new turn. The pause clears on done/error below.
  useEffect(() => window.api.chat.onApprovalPending(() => setAwaiting(true)), [setAwaiting]);
  useEffect(() => window.api.chat.onDone(() => setAwaiting(false)), [setAwaiting]);
  useEffect(
    () =>
      window.api.chat.onError((message) => {
        setAwaiting(false);
        setError(message || "Generation failed.");
      }),
    [setAwaiting],
  );

  // Main emits chat:done with the logged generation's id so the UI can
  // attach a thumbs up/down to that exact generation.
  useEffect(
    () => window.api.chat.onDone(({ generationId }) => setLastGenerationId(generationId)),
    [],
  );

  // Main emits chat:result (manifest + files) once a turn writes files.
  useEffect(
    () =>
      window.api.chat.onResult((r) => {
        setResult(r);
        if (lastPrompt) updateHistoryResourceName(lastPrompt, r.resourceName);
      }),
    [lastPrompt, updateHistoryResourceName],
  );

  // Dynamic follow-up suggestions: once a turn finishes (a generation id
  // landed and we're idle), ask main to propose next-step prompts grounded in
  // what was just built. Best-effort — a failure just leaves no chips. New turns
  // clear `followups` (in send/newSession/openThread/clone) so stale chips never
  // linger; the req-id drops any response a newer turn has superseded.
  useEffect(() => {
    if (!lastGenerationId || isGenerating) return;
    const req = ++followupReq.current;
    void (async () => {
      const accessToken = (await getToken().catch(() => null)) ?? undefined;
      const res = await window.api.chat
        .suggestFollowups({
          threadId: sessionId,
          accessToken,
          ...(workspaceId ? { workspaceId } : {}),
        })
        .catch(() => null);
      if (req !== followupReq.current) return;
      if (res?.ok) setFollowups(res.suggestions ?? []);
    })();
  }, [lastGenerationId, isGenerating, sessionId, getToken, workspaceId]);

  const send = useCallback(
    (text: string, model?: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // While a gated tool is paused, a typed reply is an approve/decline, not a
      // new turn. Resolve via chat.approve and keep the run going. An
      // unrecognizable reply keeps the pause — the buttons remain the fallback.
      if (awaitingApprovalRef.current) {
        const intent = classifyApprovalIntent(trimmed);
        if (intent === "unclear") return;
        setAwaiting(false);
        void window.api.chat.approve(intent === "approve");
        return;
      }
      if (isGenerating) return;
      // Monthly quota gate (prod only — dev-bypass always allows). Catches the
      // history-rerun path that doesn't go through the disabled submit button.
      if (!isDev && !canGenerate) {
        setError(
          "You've reached your monthly generation limit. Upgrade to Pro in Settings → Subscription.",
        );
        return;
      }
      addToHistory(trimmed);
      setLastPrompt(trimmed);
      setLastGenerationId(null); // new turn invalidates the prior feedback target
      setError(null); // clear any prior error when starting a new turn
      setFollowups([]); // drop the prior turn's suggestions while the next runs
      // Fetch the access token (null in dev-bypass) then send. Model + token ride in
      // the request body — IpcChatTransport forwards both to chat:start.
      void (async () => {
        const accessToken = await getToken().catch(() => null);
        const body: { model?: string; accessToken?: string; workspaceId?: string } = {};
        if (model) body.model = model;
        if (accessToken) body.accessToken = accessToken;
        // Active workspace scopes cloud chat memory to the tenant.
        if (workspaceId) body.workspaceId = workspaceId;
        void sendMessage({ text: trimmed }, Object.keys(body).length > 0 ? { body } : undefined);
      })();
    },
    [
      isGenerating,
      addToHistory,
      sendMessage,
      setAwaiting,
      getToken,
      canGenerate,
      isDev,
      workspaceId,
    ],
  );

  const newSession = useCallback(() => {
    setSessionId(crypto.randomUUID());
    setResult(null);
    setLastPrompt("");
    setLastGenerationId(null);
    setAwaiting(false);
    setError(null);
    setFollowups([]);
  }, [setAwaiting]);

  // Branch the current thread: copy its messages into a new thread
  // server-side (so the agent keeps the prior context), then switch the UI to the
  // new thread seeded with the same visible messages. No-op while generating.
  const clone = useCallback(async () => {
    if (isGenerating || messages.length === 0) return;
    const carried = messages;
    const newId = crypto.randomUUID();
    const accessToken = (await getToken().catch(() => null)) ?? undefined;
    const result = await window.api.chat.clone({
      sourceThreadId: sessionId,
      newThreadId: newId,
      accessToken,
      ...(workspaceId ? { workspaceId } : {}),
    });
    if (!result.ok) {
      setError(result.error ?? "Couldn't clone this conversation.");
      return;
    }
    setResult(null);
    setLastGenerationId(null);
    setAwaiting(false);
    setError(null);
    setFollowups([]);
    setPendingSeed(carried);
    setSessionId(newId);
  }, [isGenerating, messages, sessionId, getToken, workspaceId, setAwaiting]);

  // Open a persisted conversation: load its messages from cloud memory
  // and switch the UI to that thread, seeded with its history. No-op while
  // generating or if it's already the active thread.
  const openThread = useCallback(
    async (threadId: string) => {
      if (isGenerating || threadId === sessionId) return;
      const accessToken = (await getToken().catch(() => null)) ?? undefined;
      const res = await window.api.chat.loadThread({
        threadId,
        accessToken,
        ...(workspaceId ? { workspaceId } : {}),
      });
      if (!res.ok) {
        setError(res.error ?? "Couldn't open this conversation.");
        return;
      }
      setResult(null);
      setLastGenerationId(null);
      setAwaiting(false);
      setError(null);
      setFollowups([]);
      setPendingSeed((res.messages ?? []) as UIMessage[]);
      setSessionId(threadId);
    },
    [isGenerating, sessionId, getToken, workspaceId, setAwaiting],
  );

  const undo = useCallback(async () => {
    if (result?.manifestPath) {
      await window.api.undoGeneration(result.manifestPath);
      setResult(null);
    }
  }, [result]);

  const status_ = useMemo(() => {
    if (isGenerating) return "Generating…";
    if (result) return `Done — ${result.resourceName} (${result.files.length} files)`;
    return "Ready";
  }, [isGenerating, result]);

  return {
    messages,
    isGenerating,
    status: status_,
    result,
    lastGenerationId,
    canUndo: !!result?.manifestPath,
    awaitingApproval,
    error,
    followups,
    promptHistory,
    send,
    cancel: () => void stop(),
    clearHistory,
    newSession,
    clone,
    sessionId,
    openThread,
    undo,
    clearResult: () => setResult(null),
  };
}
