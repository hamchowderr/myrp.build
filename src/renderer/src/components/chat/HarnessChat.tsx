/**
 * Harness chat view — the alpha counterpart to
 * AEChat, shown only when the default-OFF useHarness flag is on. Where AEChat
 * renders AI-SDK UIMessage parts from useAEChat, this renders the Harness
 * transcript from {@link useHarnessChat} (folded by reduceHarnessEvent) on the
 * SAME ai-elements primitives: text → MessageResponse, thinking → Reasoning,
 * tool calls → Tool, task_updated → Task, approvals → an inline gate, the live
 * run → Shimmer.
 *
 * Ported from mastra-chat-kit's HarnessChat, trimmed to the ox generator: the
 * kit's image/knowledge/plan tool-views don't apply here, and token-usage
 * (Context) + follow-up Queue surfaces are deferred. The richer DisplayState
 * surfaces + the official ai-elements adoption are follow-ups.
 */

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@renderer/components/ai-elements/chain-of-thought";
import {
  Commit,
  CommitContent,
  CommitFile,
  CommitFileIcon,
  CommitFileInfo,
  CommitFilePath,
  CommitFileStatus,
  CommitFiles,
  CommitHeader,
  CommitMessage,
  CommitMetadata,
} from "@renderer/components/ai-elements/commit";
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRequest,
  ConfirmationTitle,
} from "@renderer/components/ai-elements/confirmation";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@renderer/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@renderer/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@renderer/components/ai-elements/reasoning";
import { Shimmer } from "@renderer/components/ai-elements/shimmer";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@renderer/components/ai-elements/sources";
import { Suggestion } from "@renderer/components/ai-elements/suggestion";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@renderer/components/ai-elements/task";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@renderer/components/ai-elements/tool";
import { usePromptHistory } from "@renderer/hooks/chat/usePromptHistory";
import { useAccount } from "@renderer/lib/account";
import {
  type ChangedFile,
  collectToolResults,
  deriveChangedFiles,
  deriveTaskList,
  type HarnessContentPart,
  type HarnessSource,
  type HarnessTaskItem,
  SUPPRESSED_INLINE_TOOLS,
} from "@renderer/lib/harness/events";
import type { UseHarnessChat } from "@renderer/lib/harness/use-harness-chat";
import { toolLabel } from "@renderer/lib/tool-labels";
import type { ServerContext } from "@renderer/lib/types";
import { cn } from "@renderer/lib/utils";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  FileStack,
  LoaderCircle,
  type LucideIcon,
  type LucideProps,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChatAvatar } from "./ChatAvatar";
import { ChatEmptyState } from "./ChatEmptyState";
import { ChatInput } from "./ChatInput";
import { FeedbackActions } from "./FeedbackActions";
import { SuspensionCard } from "./SuspensionCard";

interface HarnessChatProps {
  /** The harness chat hook, lifted to Generator so the sidebar shares it. */
  chat: UseHarnessChat;
  context: ServerContext;
  onOpenSettings: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
}

/** Narrow an unknown value to a plain record for safe field access. */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/** Render one Harness content part, pairing tool_call → its tool_result by id. */
function renderContent(
  part: HarnessContentPart,
  i: number,
  resultsById: Map<string, HarnessContentPart>,
  streaming = false,
) {
  if (part.type === "text") {
    return <MessageResponse key={i}>{(part as { text: string }).text}</MessageResponse>;
  }
  if (part.type === "thinking") {
    // Auto-open live thinking while the turn streams, then let it collapse — matches
    // AEChat. defaultOpen seeds the initial state; isStreaming keeps it live.
    return (
      <Reasoning key={i} defaultOpen={streaming} isStreaming={streaming}>
        <ReasoningTrigger />
        <ReasoningContent>{(part as { thinking: string }).thinking}</ReasoningContent>
      </Reasoning>
    );
  }
  if (part.type === "tool_call") {
    const call = part as { id: string; name: string; args: unknown };
    // Task bookkeeping (task_*) is shown as the consolidated checklist; ask_user /
    // submit_plan as the SuspensionCard — never as inline wrench cards.
    if (SUPPRESSED_INLINE_TOOLS.has(call.name)) return null;
    const result = resultsById.get(call.id) as { result?: unknown; isError?: boolean } | undefined;
    const hasOutput = result !== undefined;
    const out = result?.result;
    const outText = typeof out === "string" ? out : JSON.stringify(out, null, 2);
    // Subagent delegations read best as prose: the header already names the
    // specialist, so show the plain `task` it was given + the `content` it
    // returned, instead of dumping the raw {agentType,task}/{content} JSON.
    const sub = call.name === "subagent" ? asRecord(call.args) : undefined;
    const subTask = typeof sub?.task === "string" ? sub.task : undefined;
    const subResult = hasOutput ? asRecord(out)?.content : undefined;
    return (
      <Tool key={i}>
        <ToolHeader
          type={`tool-${call.name}`}
          state={hasOutput ? "output-available" : "input-available"}
          title={toolLabel(`tool-${call.name}`, call.args)}
        />
        <ToolContent>
          {subTask !== undefined ? (
            // Cap the delegation body and scroll INSIDE the card so a long
            // specialist report doesn't push the whole chat down.
            <div className="max-h-96 space-y-2 overflow-y-auto p-3 text-xs leading-relaxed">
              <p className="whitespace-pre-wrap">
                <span className="text-muted-foreground">Task — </span>
                {subTask}
              </p>
              {typeof subResult === "string" && subResult && (
                <div className="border-border/60 border-t pt-2">
                  <p className="mb-1 text-muted-foreground">Result</p>
                  <MessageResponse>{subResult}</MessageResponse>
                </div>
              )}
            </div>
          ) : (
            <>
              <ToolInput input={call.args} />
              {hasOutput && (
                <ToolOutput
                  output={result?.isError ? undefined : outText}
                  errorText={result?.isError ? outText : undefined}
                />
              )}
            </>
          )}
        </ToolContent>
      </Tool>
    );
  }
  // tool_result is rendered alongside its tool_call; skip standalone.
  if (part.type === "tool_result") return null;
  if (part.type === "system_reminder") {
    return (
      <p className="text-muted-foreground text-xs" key={i}>
        {(part as { message: string }).message}
      </p>
    );
  }
  return null;
}

/** Three bouncing dots shown while the agent responds but nothing has streamed yet. */
function ThinkingDots() {
  return (
    <span className="flex items-center gap-1" role="status" aria-label="Agent is responding">
      <span className="size-1.5 animate-bounce rounded-full bg-text-dim [animation-delay:0ms]" />
      <span className="size-1.5 animate-bounce rounded-full bg-text-dim [animation-delay:150ms]" />
      <span className="size-1.5 animate-bounce rounded-full bg-text-dim [animation-delay:300ms]" />
    </span>
  );
}

/** Bot avatar + dots, shown before the assistant message row exists (matches AEChat). */
function ThinkingIndicator() {
  return (
    <div className="animate-fade-slide-in flex items-center gap-2.5 py-1">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-text-muted">
        <Bot className="size-4" />
      </div>
      <ThinkingDots />
    </div>
  );
}

/** Map a Harness task status to a Chain-of-Thought step status. */
const COT_STATUS: Record<string, "complete" | "active" | "pending"> = {
  completed: "complete",
  in_progress: "active",
  pending: "pending",
};

/** Spinning loader for the in-progress step. Chain-of-Thought renders the step
 *  icon statically, so we wrap LoaderCircle to keep the "working now" motion. */
const ActiveIcon = (props: LucideProps) => (
  <LoaderCircle {...props} className={cn(props.className as string, "animate-spin")} />
);

/** The agent's plan as the official ai-elements Chain-of-Thought timeline with
 *  live per-step status (complete ✓ · active spinner+activeForm · pending ○) —
 *  replaces the pile of task_* wrench cards. Fed by
 *  deriveTaskList (live task_updated snapshot, else reconstructed). */
function TaskChecklist({ tasks }: { tasks: HarnessTaskItem[] }) {
  const done = tasks.filter((t) => t.status === "completed").length;
  return (
    <ChainOfThought defaultOpen={done < tasks.length}>
      <ChainOfThoughtHeader>{`Plan · ${done}/${tasks.length} done`}</ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {tasks.map((t, i) => {
          const status = t.status ?? "pending";
          const icon =
            status === "completed" ? CheckCircle2 : status === "in_progress" ? ActiveIcon : Circle;
          const label =
            status === "in_progress" && t.activeForm
              ? t.activeForm
              : (t.content ?? t.title ?? "Task");
          return (
            <ChainOfThoughtStep
              key={t.id ?? `task-${i}`}
              icon={icon as LucideIcon}
              label={label}
              status={COT_STATUS[status] ?? "pending"}
            />
          );
        })}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

/** Friendly label for one ox RAG citation — the source type ("ox_inventory"),
 *  falling back to the doc URL's last segment. */
function sourceLabel(s: HarnessSource): string {
  if (s.sourceType && s.sourceType !== "unknown") return s.sourceType;
  const seg = s.sourceUrl.split(/[/#?]/).filter(Boolean).pop();
  return seg ?? s.sourceUrl;
}

/** One RAG citation — a link to the ox doc when it's a real URL (Electron opens
 *  target=_blank via shell.openExternal), else a display-only label. */
function SourceRow({ source }: { source: HarnessSource }) {
  const isUrl = /^https?:\/\//i.test(source.sourceUrl);
  return <Source {...(isUrl ? { href: source.sourceUrl } : {})} title={sourceLabel(source)} />;
}

/** Strip the "[local]/" workspace prefix for a cleaner path display. */
function prettyPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\[local\]\//, "");
}

/** The turn's file writes as ONE git-style "Changed files" card (official
 *  ai-elements Commit) — replaces the pile of inline Wrote/Edited cards; reads
 *  are hidden, mutations consolidated here. */
function ChangedFilesCard({ files }: { files: ChangedFile[] }) {
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const f of files) counts[f.status]++;
  const summary = [
    counts.added && `${counts.added} added`,
    counts.modified && `${counts.modified} modified`,
    counts.deleted && `${counts.deleted} deleted`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Commit defaultOpen>
      <CommitHeader>
        <div className="flex items-center gap-2">
          <FileStack className="size-4 text-muted-foreground" />
          <CommitMessage>Changed files ({files.length})</CommitMessage>
        </div>
        <div className="flex items-center gap-2">
          <CommitMetadata>{summary}</CommitMetadata>
          <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </div>
      </CommitHeader>
      <CommitContent>
        <CommitFiles>
          {files.map((f) => (
            <CommitFile key={f.path}>
              <CommitFileInfo>
                <CommitFileStatus status={f.status} />
                <CommitFileIcon />
                <CommitFilePath>{prettyPath(f.path)}</CommitFilePath>
              </CommitFileInfo>
            </CommitFile>
          ))}
        </CommitFiles>
      </CommitContent>
    </Commit>
  );
}

export function HarnessChat({
  chat,
  context,
  onOpenSettings,
  isDark,
  onToggleTheme,
}: HarnessChatProps): React.JSX.Element {
  const { transcript, status, sendMessage, approve, respondSuspension, cancel } = chat;
  const {
    messages,
    threadId,
    tasks,
    pendingApproval,
    pendingSuspensions,
    activeSubagents,
    mode,
    usage,
    lastGenerationId,
    sources,
    error,
  } = transcript;
  const resultsById = collectToolResults(messages);
  // The agent's plan as one checklist: live task_updated snapshot, else rebuilt
  // from the last task-tool result so reopened conversations show it too.
  const taskList = useMemo(() => deriveTaskList(messages, tasks), [messages, tasks]);
  // The turn's file writes, consolidated into the "Changed files" commit card
  // (the inline Wrote/Edited cards are suppressed by SUPPRESSED_INLINE_TOOLS).
  const changedFiles = useMemo(() => deriveChangedFiles(messages), [messages]);
  const isGenerating = status === "streaming";
  const visibleMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const lastVisible = visibleMessages[visibleMessages.length - 1];
  // Standalone Bot + dots only BEFORE an assistant row exists; once it does, the row
  // owns the avatar and the dots render inline inside it (avoids a double Bot icon).
  const showThinking =
    isGenerating && !pendingApproval && (!lastVisible || lastVisible.role === "user");
  // Auth for the prod path: the Supabase token (null in dev-bypass → main signs in
  // the seeded dev user) + the active workspace scope cloud memory + the inference
  // proxy. Without these the Harness path only works in dev-bypass. Quota is
  // enforced server-side at the proxy.
  const { getToken, workspaceId } = useAccount();

  // Prompt history parity with AEChat: the localStorage-backed store is
  // shared, so the ChatInput history dropdown shows the same entries here. Only
  // one chat path is active per session, so this isolated instance is safe.
  const { promptHistory, addToHistory, clearHistory } = usePromptHistory();

  // Model-generated follow-up suggestions for the just-finished turn (parity with
  // AEChat). Keyed on the HARNESS thread + logged-generation id (unlike AEChat's
  // legacy useChat sessionId, which the Harness path never populates). A req-id
  // guards against a stale response from a prior turn clobbering a newer one.
  const [followups, setFollowups] = useState<string[]>([]);
  const followupReq = useRef(0);
  useEffect(() => {
    if (!lastGenerationId || !threadId || isGenerating) return;
    const req = ++followupReq.current;
    void (async () => {
      const accessToken = await getToken()
        .then((t) => t ?? undefined)
        .catch(() => undefined);
      const res = await window.api.chat
        .suggestFollowups({
          threadId,
          ...(accessToken ? { accessToken } : {}),
          ...(workspaceId ? { workspaceId } : {}),
        })
        .catch(() => null);
      if (req !== followupReq.current) return;
      if (res?.ok) setFollowups(res.suggestions ?? []);
    })();
  }, [lastGenerationId, threadId, isGenerating, getToken, workspaceId]);

  const handleSend = (text: string, model?: string): void => {
    addToHistory(text.trim()); // parity: record the prompt for the history dropdown
    setFollowups([]); // drop the prior turn's suggestions while the next runs
    // Pass the token as a lazy thunk (not pre-awaited) so sendMessage renders the
    // optimistic user message + spinner FIRST, then resolves the token off the
    // critical paint path — a suggestion click is instant now.
    void sendMessage(text, {
      ...(model ? { model } : {}),
      getAccessToken: () =>
        getToken()
          .then((t) => t ?? undefined)
          .catch(() => undefined),
      ...(workspaceId ? { workspaceId } : {}),
    });
  };

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
      {/* DisplayState strip: active mode + live token usage. */}
      {(mode || usage?.totalTokens != null) && (
        <div className="flex items-center gap-3 px-4 py-1.5 text-text-muted text-xs">
          {mode && (
            <span className="rounded bg-secondary px-1.5 py-0.5 font-medium text-text-muted">
              {mode}
            </span>
          )}
          {usage?.totalTokens != null && (
            <span>{usage.totalTokens.toLocaleString()} tokens this conversation</span>
          )}
        </div>
      )}
      {messages.length === 0 ? (
        <ChatEmptyState onSend={(t) => handleSend(t)} />
      ) : (
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="mx-auto flex max-w-[720px] flex-col gap-4">
            {visibleMessages.map((m, idx) => {
              const isLastAssistant = m.role === "assistant" && idx === visibleMessages.length - 1;
              const hasVisible = m.content.some(
                (p) => p.type === "text" || p.type === "thinking" || p.type === "tool_call",
              );
              return (
                <div key={m.id}>
                  <div
                    className={cn(
                      "flex w-full items-start gap-2.5",
                      m.role === "user" && "flex-row-reverse",
                    )}
                  >
                    <ChatAvatar role={m.role} />
                    <Message from={m.role} className="min-w-0 flex-1">
                      <MessageContent>
                        {m.content.map((part, i) =>
                          renderContent(part, i, resultsById, isLastAssistant && isGenerating),
                        )}
                        {/* Inline dots when the assistant row exists but nothing streamed yet. */}
                        {isLastAssistant && isGenerating && !hasVisible && <ThinkingDots />}
                      </MessageContent>
                    </Message>
                  </div>
                  {/* Thumbs up/down on the just-finished generation. */}
                  {isLastAssistant && !isGenerating && lastGenerationId && (
                    <FeedbackActions generationId={lastGenerationId} />
                  )}
                  {/* Follow-up suggestion chips grounded in what was just built.
                    Wrapped so all chips stay within the chat column. */}
                  {isLastAssistant &&
                    !isGenerating &&
                    !pendingApproval &&
                    !error &&
                    followups.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2 pl-[38px]">
                        {followups.map((s) => (
                          <Suggestion key={s} suggestion={s} onClick={(t) => handleSend(t)} />
                        ))}
                      </div>
                    )}
                  {/* RAG citations — the ox docs that grounded this turn. */}
                  {isLastAssistant && !isGenerating && sources.length > 0 && (
                    <div className="mt-2 pl-[38px]">
                      <Sources>
                        <SourcesTrigger count={sources.length} />
                        <SourcesContent>
                          {sources.map((s) => (
                            <SourceRow key={s.sourceUrl} source={s} />
                          ))}
                        </SourcesContent>
                      </Sources>
                    </div>
                  )}
                </div>
              );
            })}

            {taskList.length > 0 && <TaskChecklist tasks={taskList} />}

            {/* The turn's file writes as one git-style card, replacing the inline
              Wrote/Edited cards. */}
            {changedFiles.length > 0 && <ChangedFilesCard files={changedFiles} />}

            {/* Live subagent activity: which specialists the supervisor is
              delegating to, and the sub-tool each is running. */}
            {activeSubagents.length > 0 && (
              <Task defaultOpen>
                <TaskTrigger title={`Delegating (${activeSubagents.length})`} />
                <TaskContent>
                  {activeSubagents.map((s) => (
                    <TaskItem key={s.toolCallId}>
                      <Shimmer className="text-xs">
                        {`${s.agentType}${s.currentTool ? ` · ${s.currentTool}` : ` · ${s.task}`}`}
                      </Shimmer>
                    </TaskItem>
                  ))}
                </TaskContent>
              </Task>
            )}

            {/* Suspended tools awaiting a human answer (ask_user / submit_plan):
              the interactive card resumes the SAME run via respondSuspension. */}
            {pendingSuspensions.map((s) => (
              <SuspensionCard
                key={s.toolCallId}
                suspension={s}
                disabled={status === "streaming"}
                onRespond={respondSuspension}
              />
            ))}

            {/* Approval gate via the official ai-elements Confirmation. We
              feed our Harness pendingApproval as a synthetic ToolUIPart approval
              (id + "approval-requested"); the card unmounts when the reducer
              clears pendingApproval on the decision. */}
            {pendingApproval && (
              <Confirmation
                approval={{ id: pendingApproval.toolCallId }}
                state="approval-requested"
                className="mx-auto max-w-[720px] border-amber-500/30 bg-amber-500/5"
              >
                <ConfirmationTitle>
                  Run <span className="font-medium">{pendingApproval.toolName}</span>? This action
                  needs your approval before it runs.
                </ConfirmationTitle>
                <ConfirmationRequest>
                  <ConfirmationActions>
                    <ConfirmationAction
                      variant="outline"
                      onClick={() => void approve("decline", pendingApproval.toolCallId)}
                    >
                      Decline
                    </ConfirmationAction>
                    <ConfirmationAction
                      onClick={() => void approve("approve", pendingApproval.toolCallId)}
                    >
                      Approve
                    </ConfirmationAction>
                  </ConfirmationActions>
                </ConfirmationRequest>
              </Confirmation>
            )}

            {showThinking && <ThinkingIndicator />}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}

      {error && (
        <div className="mx-auto w-full max-w-[720px] px-3 pb-2">
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span className="flex-1">{error}</span>
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-[720px]">
        <ChatInput
          onSend={handleSend}
          onCancel={() => void cancel()}
          isGenerating={isGenerating}
          awaitingApproval={!!pendingApproval}
          context={context}
          promptHistory={promptHistory}
          onRerunPrompt={(p) => handleSend(p)}
          onClearHistory={clearHistory}
          onOpenSettings={onOpenSettings}
          isDark={isDark}
          onToggleTheme={onToggleTheme}
        />
      </div>
    </div>
  );
}
