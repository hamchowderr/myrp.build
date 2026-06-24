/**
 * AI-Elements chat view (fivem-studio-k8v) — the Cursor-style streaming UI.
 *
 * Presentational: chat state comes from useAEChat (lifted in Generator).
 * Renders AI SDK v6 UIMessage parts via AI Elements — text -> MessageResponse,
 * reasoning -> Reasoning, tool calls -> collapsible Tool rows — and uses the
 * production ChatInput.
 */

import {
  Checkpoint,
  CheckpointIcon,
  CheckpointTrigger,
} from "@renderer/components/ai-elements/checkpoint";
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
import { Suggestion } from "@renderer/components/ai-elements/suggestion";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@renderer/components/ai-elements/tool";
import { Avatar, AvatarFallback, AvatarImage } from "@renderer/components/ui/avatar";
import { Button } from "@renderer/components/ui/button";
import { useAccount } from "@renderer/lib/account";
import { toolLabel } from "@renderer/lib/tool-labels";
import type { PromptHistoryEntry, ServerContext } from "@renderer/lib/types";
import { cn } from "@renderer/lib/utils";
import type { ToolUIPart, UIMessage } from "ai";
import { Bot, Check, TriangleAlert, Undo2, User } from "lucide-react";
import { useState } from "react";
import { ChatInput } from "./ChatInput";
import { FeedbackActions } from "./FeedbackActions";

// Starter examples shown in the empty state (the card grid).
const SUGGESTIONS = [
  "A car dealership with test drive support",
  "HUD with health, armor, and minimap toggle",
  "Drug crafting system with ox_inventory items",
  "Police MDT with warrant lookup and BOLO system",
];

interface AEChatProps {
  messages: UIMessage[];
  isGenerating: boolean;
  /** A gated tool is paused awaiting approval (xqc.1) — typed replies approve/decline it. */
  awaitingApproval: boolean;
  /** Upstream error (out-of-credits / bad key / rate-limit) to show instead of failing silently. */
  error: string | null;
  /** Model-generated follow-up suggestions for the just-finished turn (zjni). */
  followups: string[];
  /** Logged generation id for the just-finished turn — enables thumbs feedback (zhk.9). */
  lastGenerationId: string | null;
  context: ServerContext;
  promptHistory: PromptHistoryEntry[];
  /** Whether the last generation can be reverted (has a manifest) — drives the checkpoint. */
  canUndo: boolean;
  /** Revert the last generation's written files (undoGeneration). */
  onUndo: () => Promise<void>;
  onSend: (text: string, model?: string) => void;
  onCancel: () => void;
  onClearHistory: () => void;
  onOpenSettings: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
}

type AnyPart = UIMessage["parts"][number];

function isToolPart(part: AnyPart): part is ToolUIPart {
  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

/** Has the assistant produced anything visible yet (text, reasoning, or a tool)? */
function hasVisibleParts(message: UIMessage): boolean {
  return message.parts.some((p) => p.type === "text" || p.type === "reasoning" || isToolPart(p));
}

/** The three bouncing dots shown while the agent is responding but nothing has streamed yet. */
function ThinkingDots() {
  return (
    <span className="flex items-center gap-1" role="status" aria-label="Agent is responding">
      <span className="size-1.5 animate-bounce rounded-full bg-text-dim [animation-delay:0ms]" />
      <span className="size-1.5 animate-bounce rounded-full bg-text-dim [animation-delay:150ms]" />
      <span className="size-1.5 animate-bounce rounded-full bg-text-dim [animation-delay:300ms]" />
    </span>
  );
}

/**
 * Standalone Bot icon + dots, shown ONLY before the assistant message exists
 * (i.e. right after the user's turn). Once the assistant message row exists, the
 * dots render inline inside that row instead (see MessageContent below) so there
 * is never a second Bot avatar floating beside the message's own avatar (wzi).
 */
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

function ToolRow({ tool }: { tool: ToolUIPart }) {
  const out = tool.output;
  const awaitingApproval = tool.state === "approval-requested";
  // STABLE card (fivem-studio-475e): the header's status badge updates in place
  // (Pending → Running → Completed) with no height change, so a multi-step turn
  // no longer flickers from cards auto-expanding while running and snapping shut
  // on finish. The card stays collapsed; the user expands it to inspect the
  // input/output. A tool awaiting approval force-opens so its approve/decline
  // buttons are visible. (Foreman renders tool cards this way too — no auto-open.)
  const [open, setOpen] = useState(false);
  return (
    <Tool open={open || awaitingApproval} onOpenChange={setOpen}>
      <ToolHeader type={tool.type} state={tool.state} title={toolLabel(tool.type, tool.input)} />
      <ToolContent>
        {tool.input !== undefined && <ToolInput input={tool.input} />}
        {awaitingApproval && (
          <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
            <span className="flex-1 text-xs text-muted-foreground">
              This action needs your approval before it runs.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => void window.api.chat.approve(false)}
            >
              Decline
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => void window.api.chat.approve(true)}
            >
              Approve
            </Button>
          </div>
        )}
        {(out !== undefined || tool.errorText) && (
          <ToolOutput
            output={typeof out === "string" ? out : JSON.stringify(out, null, 2)}
            errorText={tool.errorText}
          />
        )}
      </ToolContent>
    </Tool>
  );
}

/**
 * Restore-point row under the last generation. Owns the restore lifecycle so the
 * user gets clear feedback: clicking Restore shows "Restoring…", then a green
 * "Restored — files removed" confirmation (the checkpoint no longer just vanishes
 * with no signal). On failure it surfaces an error and lets the user retry.
 */
function CheckpointRow({ canUndo, onUndo }: { canUndo: boolean; onUndo: () => Promise<void> }) {
  const [state, setState] = useState<"idle" | "restoring" | "restored" | "error">("idle");

  if (state === "restored") {
    return (
      <Checkpoint>
        <CheckpointIcon>
          <Check className="size-3.5 text-accent-green" />
        </CheckpointIcon>
        <span>Restored — generated files removed</span>
      </Checkpoint>
    );
  }

  if (!canUndo) return null;

  return (
    <Checkpoint>
      <CheckpointIcon />
      <span>Checkpoint</span>
      <CheckpointTrigger
        tooltip="Undo this generation — delete the files it wrote"
        disabled={state === "restoring"}
        onClick={() => {
          setState("restoring");
          onUndo()
            .then(() => setState("restored"))
            .catch(() => setState("error"));
        }}
      >
        <Undo2 className="size-3" />
        {state === "restoring" ? "Restoring…" : state === "error" ? "Retry" : "Restore"}
      </CheckpointTrigger>
      {state === "error" && <span className="text-destructive">Restore failed</span>}
    </Checkpoint>
  );
}

/**
 * Round avatar next to each message. AI Elements ships no avatar component, so
 * this is a custom piece (per the owner's call) — the assistant's Bot icon
 * matches ThinkingIndicator so it persists instead of vanishing when the real
 * message streams in. The user's own messages use their Discord photo when
 * signed in (c4c), falling back to the generic User icon (dev-bypass / no photo).
 */
function ChatAvatar({ role }: { role: UIMessage["role"] }) {
  const isUser = role === "user";
  const { avatarUrl, displayName } = useAccount();
  if (isUser && avatarUrl) {
    return (
      <Avatar className="size-7">
        <AvatarImage src={avatarUrl} alt={displayName || "You"} />
        <AvatarFallback className="bg-secondary text-text-muted">
          <User className="size-4" />
        </AvatarFallback>
      </Avatar>
    );
  }
  return (
    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-text-muted">
      {isUser ? <User className="size-4" /> : <Bot className="size-4" />}
    </div>
  );
}

/** Rockstar-style star logo for the empty state. */
function StudioLogo() {
  return (
    <div className="animate-fade-slide-in mb-6" style={{ animationDelay: "0ms" }}>
      <svg
        width="56"
        height="56"
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="drop-shadow-lg"
        aria-hidden="true"
      >
        <path
          d="M32 4L38.9 22.5H58.4L42.7 34.5L49.6 53L32 41L14.4 53L21.3 34.5L5.6 22.5H25.1L32 4Z"
          className="fill-foreground/90"
        />
        <path
          d="M32 14L36.4 25.5H48.6L38.9 33L43.4 44.5L32 37L20.6 44.5L25.1 33L15.4 25.5H27.6L32 14Z"
          className="fill-background"
        />
      </svg>
    </div>
  );
}

function MessageParts({ message }: { message: UIMessage }) {
  // Render each part inline in order. Tools render as individual stable <Tool>
  // cards (the AI Elements native pattern, matching Foreman) rather than coalesced
  // into a Task checklist — Task is for streamObject todo lists, not tool grouping.
  return (
    <>
      {message.parts.map((part, i) => {
        if (isToolPart(part)) return <ToolRow key={i} tool={part} />;
        if (part.type === "text") return <MessageResponse key={i}>{part.text}</MessageResponse>;
        if (part.type === "reasoning") {
          return (
            <Reasoning key={i} isStreaming={part.state === "streaming"}>
              <ReasoningTrigger />
              <ReasoningContent>{part.text}</ReasoningContent>
            </Reasoning>
          );
        }
        return null;
      })}
    </>
  );
}

export function AEChat({
  messages,
  isGenerating,
  awaitingApproval,
  error,
  followups,
  lastGenerationId,
  context,
  promptHistory,
  canUndo,
  onUndo,
  onSend,
  onCancel,
  onClearHistory,
  onOpenSettings,
  isDark,
  onToggleTheme,
}: AEChatProps): React.JSX.Element {
  const isEmpty = messages.length === 0;
  // Standalone thinking indicator: ONLY before the assistant message row exists
  // (no messages yet, or the last message is still the user's). Once an empty
  // assistant message exists, its row owns the avatar and the dots render inline
  // inside it — showing the standalone indicator too would render a SECOND Bot
  // avatar next to the message's own (the wzi double-icon during the RAG/skill
  // init gap, most visible on the first turn).
  const lastMessage = messages[messages.length - 1];
  const showThinking =
    isGenerating && !awaitingApproval && (!lastMessage || lastMessage.role === "user");

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
      {isEmpty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 text-center">
          <StudioLogo />
          <p className="animate-fade-slide-in mb-1 text-lg font-bold tracking-tight text-text-primary">
            What do you want to build?
          </p>
          <p
            className="animate-fade-slide-in mb-8 text-sm text-text-muted"
            style={{ animationDelay: "60ms" }}
          >
            Describe a FiveM resource and it will be generated to disk
          </p>
          <div className="grid w-full max-w-lg grid-cols-2 gap-2">
            {SUGGESTIONS.map((prompt, i) => (
              <button
                key={prompt}
                type="button"
                onClick={() => onSend(prompt)}
                style={{ animationDelay: `${120 + i * 50}ms` }}
                className="animate-fade-slide-in rounded-lg border border-border-subtle px-4 py-3 text-left text-xs text-text-muted transition-all hover:-translate-y-0.5 hover:border-text-dim hover:bg-hover hover:text-text-primary hover:shadow-lg"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="mx-auto max-w-[720px]">
            {messages.map((message, i) => {
              const isLastAssistant = message.role === "assistant" && i === messages.length - 1;
              return (
                // No slide-in on message items — it caused the bubble to "move
                // down" as it appeared. Messages render in place now.
                <div key={message.id}>
                  <div
                    className={cn(
                      "flex items-start gap-2.5",
                      message.role === "user" && "flex-row-reverse",
                    )}
                  >
                    <ChatAvatar role={message.role} />
                    <div className="min-w-0 flex-1">
                      <Message from={message.role}>
                        <MessageContent>
                          <MessageParts message={message} />
                          {/* Inline thinking dots: the assistant row exists but
                              nothing has streamed yet. Keeps one avatar (the row's)
                              instead of also showing the standalone indicator (wzi). */}
                          {isLastAssistant &&
                            isGenerating &&
                            !awaitingApproval &&
                            !hasVisibleParts(message) && <ThinkingDots />}
                        </MessageContent>
                      </Message>
                    </div>
                  </div>
                  {/* Feedback on the just-finished generation (zhk.9). */}
                  {isLastAssistant && !isGenerating && lastGenerationId && (
                    <FeedbackActions generationId={lastGenerationId} />
                  )}
                  {/* Restore point for the generation just written — revert its files (c72). */}
                  {isLastAssistant && !isGenerating && (
                    <CheckpointRow canUndo={canUndo} onUndo={onUndo} />
                  )}
                  {/* Follow-up suggestions: AI Elements Suggestion chips the model
                      generated from what was just built (zjni), under the last
                      reply. Wrapped (not horizontal-scroll) so all options stay
                      visible within the chat column instead of running off-side. */}
                  {isLastAssistant &&
                    !isGenerating &&
                    !awaitingApproval &&
                    !error &&
                    followups.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2 pl-[38px]">
                        {followups.map((s) => (
                          <Suggestion key={s} suggestion={s} onClick={onSend} />
                        ))}
                      </div>
                    )}
                </div>
              );
            })}
            {showThinking && <ThinkingIndicator />}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}

      {error && (
        <div className="mx-auto w-full max-w-[720px] px-3 pb-1">
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span className="flex-1">{error}</span>
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-[720px]">
        <ChatInput
          onSend={onSend}
          onCancel={onCancel}
          isGenerating={isGenerating}
          awaitingApproval={awaitingApproval}
          context={context}
          promptHistory={promptHistory}
          onRerunPrompt={onSend}
          onClearHistory={onClearHistory}
          onOpenSettings={onOpenSettings}
          isDark={isDark}
          onToggleTheme={onToggleTheme}
        />
      </div>
    </div>
  );
}
