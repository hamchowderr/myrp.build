/**
 * Client-side model of the Mastra Harness event stream (ported from
 * mastra-chat-kit `packages/web/lib/harness/events.ts` — the canonical pattern).
 *
 * The main process runs the Harness and forwards its raw `AgentControllerEvent`s
 * over IPC (the Electron equivalent of the kit's `POST /harness/stream` SSE). The
 * Harness surface is richer than AI SDK UIMessage parts (sessions, modes,
 * approvals, subagents, tasks), so instead of forcing it through `useChat` we
 * reduce the events into a small transcript model the AI Elements render
 * directly. NOTE: `display_state_changed` is intentionally NOT consumed — its
 * Map fields (activeTools/activeSubagents) serialize to `{}` over the wire, so
 * the UI is driven off the granular plain-object events.
 *
 * Only the subset of events the UI consumes is typed here; unknown events pass
 * through the reducer untouched.
 */

export type HarnessContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; result: unknown; isError?: boolean }
  | { type: "system_reminder"; message: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "file"; data: string; mediaType: string; filename?: string }
  // forward-compat: any other content kind is carried but not specially rendered
  | { type: string; [k: string]: unknown };

export type HarnessMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: HarnessContentPart[];
  createdAt?: string;
  stopReason?: "complete" | "tool_use" | "aborted" | "error";
  errorMessage?: string;
};

export type HarnessTaskItem = {
  id?: string;
  content?: string;
  title?: string;
  status?: string;
  /** Present-continuous label the agent sets for the in-progress task
   *  (e.g. "Writing the client script") — shown live in the checklist. */
  activeForm?: string;
};

export type PendingApproval = { toolCallId: string; toolName: string; args: unknown };

/** A suspended tool awaiting a human response (ask_user / request_access). */
export type PendingSuspension = {
  toolCallId: string;
  toolName: string;
  args: unknown;
  suspendPayload: unknown;
};

/** A subagent the supervisor delegated to, while it's running. */
export type ActiveSubagent = {
  toolCallId: string;
  agentType: string;
  task: string;
  /** The sub-tool it's currently running, if any (subagent_tool_start). */
  currentTool?: string;
};

/** Token usage from the Harness `usage_update` event (→ the Context element). */
export type HarnessUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
};

/** A distinct ox knowledge source that grounded a generation (RAG citation). */
export type HarnessSource = {
  sourceType: string;
  sourceUrl: string;
  similarity: number;
};

/** What the IPC consumer folds events into and the view renders. */
export type HarnessTranscript = {
  threadId: string | null;
  messages: HarnessMessage[];
  tasks: HarnessTaskItem[];
  pendingApproval: PendingApproval | null;
  /** Tools suspended awaiting a human response (ask_user / request_access). */
  pendingSuspensions: PendingSuspension[];
  /** Subagents currently delegated by the supervisor. */
  activeSubagents: ActiveSubagent[];
  /** The active Harness mode (e.g. "generate"); null until a mode_changed event. */
  mode: string | null;
  usage: HarnessUsage | null;
  queuedFollowUps: number;
  /** Id of the just-finalized generation (feedback thumbs) — the main
   *  process logs the row on turn completion and forwards the id (parity with AEChat). */
  lastGenerationId: string | null;
  /** ox docs that grounded this turn (RAG citations). */
  sources: HarnessSource[];
  error: string | null;
  done: boolean;
};

export const emptyTranscript = (): HarnessTranscript => ({
  threadId: null,
  messages: [],
  tasks: [],
  pendingApproval: null,
  pendingSuspensions: [],
  activeSubagents: [],
  mode: null,
  usage: null,
  queuedFollowUps: 0,
  lastGenerationId: null,
  sources: [],
  error: null,
  done: false,
});

/**
 * Id of the optimistic user message the send path renders instantly (before the
 * token round-trip / IPC), so a suggestion click feels immediate. The
 * Harness later echoes the user turn with its OWN id; the reducer swaps this
 * placeholder for it (see the message_* case) so it never shows twice.
 */
export const OPTIMISTIC_USER_ID = "__optimistic_user__";

// biome-ignore lint/suspicious/noExplicitAny: HarnessEvent is a wide discriminated union; we switch on .type
type AnyEvent = { type: string; [k: string]: any };

function upsertMessage(messages: HarnessMessage[], msg: HarnessMessage): HarnessMessage[] {
  const idx = messages.findIndex((m) => m.id === msg.id);
  if (idx === -1) return [...messages, msg];
  const next = messages.slice();
  next[idx] = msg;
  return next;
}

/**
 * Pure reducer: fold one Harness event (or a transport sentinel) into the
 * transcript. Keeping this pure makes the whole transport testable without IPC
 * or React.
 */
export function reduceHarnessEvent(state: HarnessTranscript, event: AnyEvent): HarnessTranscript {
  switch (event.type) {
    case "__thread__":
      return { ...state, threadId: event.threadId ?? state.threadId };
    case "__done__":
      return {
        ...state,
        done: true,
        pendingApproval: null,
        pendingSuspensions: [],
        activeSubagents: [],
      };
    // The turn parked on an ask_user/submit_plan suspension: the run is idle
    // awaiting the user's answer. Unlike __done__, the suspension card MUST stay
    // (it's what the user answers), so keep pendingSuspensions; drop the other
    // transient run surfaces. Not `done` — the conversation continues on resume.
    case "__suspended__":
      return { ...state, pendingApproval: null, activeSubagents: [] };
    // Once a tool resolves (approved → ran, or its suspension was answered), it's
    // no longer pending. Clear the approval gate + drop the matching suspension.
    case "tool_end":
      return {
        ...state,
        pendingApproval: null,
        pendingSuspensions: state.pendingSuspensions.filter(
          (s) => s.toolCallId !== event.toolCallId,
        ),
      };
    // The run ended: clear the run-scoped transients (gate + subagents). Do NOT
    // clear pendingSuspensions here — an ask_user/submit_plan suspension parks the
    // tool and ENDS the run on purpose (tool_suspended → agent_end), then is
    // answered by a SEPARATE run. Clearing on agent_end would wipe the very card
    // the user must answer. Suspensions clear on tool_end (resolved) or __done__.
    case "agent_end":
      return { ...state, pendingApproval: null, activeSubagents: [] };
    case "mode_changed":
      return { ...state, mode: (event.modeId as string) ?? state.mode };
    case "tool_suspended":
      return {
        ...state,
        pendingSuspensions: [
          ...state.pendingSuspensions.filter((s) => s.toolCallId !== event.toolCallId),
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            suspendPayload: event.suspendPayload,
          },
        ],
      };
    case "subagent_start":
      return {
        ...state,
        activeSubagents: [
          ...state.activeSubagents.filter((s) => s.toolCallId !== event.toolCallId),
          { toolCallId: event.toolCallId, agentType: event.agentType, task: event.task },
        ],
      };
    case "subagent_tool_start":
      return {
        ...state,
        activeSubagents: state.activeSubagents.map((s) =>
          s.toolCallId === event.toolCallId ? { ...s, currentTool: event.subToolName } : s,
        ),
      };
    case "subagent_end":
      return {
        ...state,
        activeSubagents: state.activeSubagents.filter((s) => s.toolCallId !== event.toolCallId),
      };
    case "message_start":
    case "message_update":
    case "message_end": {
      if (!event.message) return state;
      const incoming = event.message as HarnessMessage;
      // The Harness echoes the user turn as its own message (role=user, fresh id);
      // drop the optimistic placeholder we rendered on send so it isn't shown twice.
      // Assistant/system messages leave the placeholder untouched.
      const base =
        incoming.role === "user"
          ? state.messages.filter((m) => m.id !== OPTIMISTIC_USER_ID)
          : state.messages;
      return { ...state, messages: upsertMessage(base, incoming) };
    }
    case "task_updated":
      return { ...state, tasks: (event.tasks as HarnessTaskItem[]) ?? state.tasks };
    case "usage_update":
      return { ...state, usage: (event.usage as HarnessUsage) ?? state.usage };
    // Fired by the main process after finalizeGeneration logs the turn — the id
    // powers the feedback thumbs on the finished generation (parity with AEChat).
    case "generation_logged":
      return {
        ...state,
        lastGenerationId: (event.generationId as string) ?? state.lastGenerationId,
      };
    // The ox docs the RAG step retrieved for this turn — shown as citations.
    case "rag_sources":
      return { ...state, sources: (event.sources as HarnessSource[]) ?? state.sources };
    case "follow_up_queued":
      return { ...state, queuedFollowUps: Number(event.count ?? 0) };
    case "tool_approval_required":
      return {
        ...state,
        pendingApproval: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        },
      };
    case "error":
      return {
        ...state,
        error: typeof event.error === "string" ? event.error : JSON.stringify(event.error),
      };
    default:
      return state;
  }
}

/** Reduce a batch of events (e.g. a full IPC flush) onto a starting state. */
export function reduceHarnessEvents(
  state: HarnessTranscript,
  events: AnyEvent[],
): HarnessTranscript {
  return events.reduce(reduceHarnessEvent, state);
}

/** Builtin task-management tools (each returns the full {tasks} snapshot). */
const TASK_TOOLS = new Set(["task_write", "task_update", "task_complete", "task_check"]);

/** Workspace file-MUTATION tools → consolidated into the "Changed files" commit
 *  card, mapped to a git-style status. */
const FILE_MUTATION_TOOLS: Record<string, "added" | "modified" | "deleted"> = {
  mastra_workspace_write_file: "added",
  mastra_workspace_edit_file: "modified",
  mastra_workspace_ast_edit: "modified",
  mastra_workspace_delete: "deleted",
};

/** Workspace file READ/explore tools → hidden from the stream (exploration noise;
 *  they change nothing, so they don't belong in the changed-files summary). */
const FILE_READ_TOOLS = new Set([
  "mastra_workspace_read_file",
  "mastra_workspace_list_files",
  "mastra_workspace_file_stat",
  "mastra_workspace_grep",
  "mastra_workspace_mkdir",
]);

/**
 * Builtin/workspace tools that already have a DEDICATED surface — the consolidated
 * task checklist (task_*), the SuspensionCard (ask_user / submit_plan), or the
 * "Changed files" commit card (file mutations) — plus file-read exploration noise,
 * so none of them render as inline wrench cards. Without this, task bookkeeping +
 * per-file write/read cards drown the real work.
 */
export const SUPPRESSED_INLINE_TOOLS = new Set([
  ...TASK_TOOLS,
  "ask_user",
  "submit_plan",
  ...Object.keys(FILE_MUTATION_TOOLS),
  ...FILE_READ_TOOLS,
]);

/**
 * The current task checklist. Prefer the live `task_updated` snapshot; when it's
 * empty — e.g. a REOPENED conversation, whose transient task_updated events aren't
 * persisted with the thread — reconstruct it from the LAST task-tool RESULT. Every
 * task tool returns the full `{ tasks }` snapshot, and tool results ARE persisted
 * in the messages, so the finished checklist survives a reload.
 */
export function deriveTaskList(
  messages: HarnessMessage[],
  liveTasks: HarnessTaskItem[],
): HarnessTaskItem[] {
  if (liveTasks.length) return liveTasks;
  let latest: HarnessTaskItem[] = [];
  for (const m of messages) {
    for (const part of m.content) {
      if (part.type === "tool_result" && TASK_TOOLS.has((part as { name?: string }).name ?? "")) {
        const tasks = (part as { result?: { tasks?: HarnessTaskItem[] } }).result?.tasks;
        if (Array.isArray(tasks)) latest = tasks;
      }
    }
  }
  return latest;
}

/** One file the agent changed this conversation, git-style. */
export type ChangedFile = { path: string; status: "added" | "modified" | "deleted" };

/** Pull a file path out of a workspace tool call's args. */
function filePathFromArgs(args: unknown): string | undefined {
  if (args && typeof args === "object") {
    const o = args as Record<string, unknown>;
    for (const k of ["path", "filePath", "file", "targetPath"]) {
      if (typeof o[k] === "string" && o[k]) return o[k] as string;
    }
  }
  return undefined;
}

const STATUS_RANK: Record<ChangedFile["status"], number> = { modified: 1, added: 2, deleted: 3 };

/**
 * Collapse the conversation's file-mutation tool calls to distinct changed files
 * for the "Changed files" commit card. Per path we keep the strongest
 * status seen (deleted > added > modified) so a create-then-edit reads as "added"
 * and a delete wins — a git-style net view rather than a per-op log.
 */
export function deriveChangedFiles(messages: HarnessMessage[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile["status"]>();
  for (const m of messages) {
    for (const part of m.content) {
      if (part.type !== "tool_call") continue;
      const status = FILE_MUTATION_TOOLS[(part as { name?: string }).name ?? ""];
      if (!status) continue;
      const path = filePathFromArgs((part as { args?: unknown }).args);
      if (!path) continue;
      const prev = byPath.get(path);
      if (!prev || STATUS_RANK[status] > STATUS_RANK[prev]) byPath.set(path, status);
    }
  }
  return [...byPath.entries()].map(([path, status]) => ({ path, status }));
}

/** Collect tool_result content across all messages, keyed by tool-call id. */
export function collectToolResults(messages: HarnessMessage[]): Map<string, HarnessContentPart> {
  const byId = new Map<string, HarnessContentPart>();
  for (const m of messages) {
    for (const part of m.content) {
      if (part.type === "tool_result" && typeof (part as { id?: string }).id === "string") {
        byId.set((part as { id: string }).id, part);
      }
    }
  }
  return byId;
}

/** A stored AI-SDK-v6 UI message part (loadThread output) — loosely typed; we
 *  read only the fields we render. */
type LoadedUIPart = {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  state?: string;
  errorText?: string;
};
type LoadedUIMessage = { id?: string; role?: string; parts?: LoadedUIPart[] };

/**
 * Convert stored AI-SDK-v6 UI messages (window.api.chat.loadThread) into the
 * transcript's HarnessMessage shape, so opening a past conversation on the
 * Harness path renders the same as the live event stream.
 * Best-effort: text, reasoning, and tool calls/results; unknown parts are skipped.
 */
export function uiMessagesToHarness(messages: unknown[]): HarnessMessage[] {
  const out: HarnessMessage[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as LoadedUIMessage;
    const content: HarnessContentPart[] = [];
    for (const part of m.parts ?? []) {
      if (part.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      } else if (part.type === "reasoning" && typeof part.text === "string") {
        content.push({ type: "thinking", thinking: part.text });
      } else if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
        const name = part.type === "dynamic-tool" ? (part.toolName ?? "tool") : part.type.slice(5);
        const id =
          typeof part.toolCallId === "string" ? part.toolCallId : `${m.id ?? "msg"}-${name}`;
        content.push({ type: "tool_call", id, name, args: part.input });
        if (part.state === "output-error") {
          content.push({
            type: "tool_result",
            id,
            name,
            result: part.errorText ?? "error",
            isError: true,
          });
        } else if (part.output !== undefined || part.state === "output-available") {
          content.push({ type: "tool_result", id, name, result: part.output });
        }
      }
    }
    const role: HarnessMessage["role"] =
      m.role === "user" ? "user" : m.role === "system" ? "system" : "assistant";
    out.push({ id: typeof m.id === "string" ? m.id : `${role}-${out.length}`, role, content });
  }
  return out;
}
