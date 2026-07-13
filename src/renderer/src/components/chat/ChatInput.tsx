/**
 * Chat input bar, built on the AI Elements `prompt-input` component.
 * No bespoke input UI — PromptInput owns the textarea, footer, submit/stop button,
 * and the model selector. App-specific extras (prompt history, server context,
 * settings/theme, the dev/prod account slot) hang off PromptInputTools.
 *
 * Enter submits; Shift+Enter newlines (prompt-input default). The selected model is
 * passed to onSend and flows through to the agent (see useAEChat -> IpcChatTransport).
 */
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@renderer/components/ai-elements/model-selector";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@renderer/components/ai-elements/prompt-input";
import { ColorModeSelector } from "@renderer/components/theme-customizer/color-mode-selector";
import { PresetSelector } from "@renderer/components/theme-customizer/preset-selector";
import { ThemeRadiusSelector } from "@renderer/components/theme-customizer/radius-selector";
import { ResetThemeButton } from "@renderer/components/theme-customizer/reset-theme";
import { ThemeScaleSelector } from "@renderer/components/theme-customizer/scale-selector";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { useVoiceInput } from "@renderer/hooks/useVoiceInput";
import { useAccount } from "@renderer/lib/account";
import type { PromptHistoryEntry, ServerContext } from "@renderer/lib/types";
import {
  CreditCard,
  History,
  Loader2,
  Mic,
  Settings,
  SlidersVertical,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useState } from "react";
import { ContextBadges } from "./ContextBadges";

// Curated model list — Anthropic-only. The user-facing picker offers only
// Anthropic models; the underlying AI Gateway stays provider-agnostic (agent.ts), so
// this is a product-level curation, not a plumbing change. Ids are bare — main
// normalizes them to `anthropic/<id>` (src/main/ipc/chat.ts).
const ANTHROPIC_MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", provider: "anthropic" as const },
  { id: "claude-opus-4-6", label: "Opus 4.6", provider: "anthropic" as const },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", provider: "anthropic" as const },
];
const MODELS = ANTHROPIC_MODELS;

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface ChatInputProps {
  onSend: (message: string, model?: string) => void;
  onCancel: () => void;
  isGenerating: boolean;
  /** A gated tool is awaiting approval — hint that a typed reply approves/declines it. */
  awaitingApproval?: boolean;
  context: ServerContext;
  promptHistory: PromptHistoryEntry[];
  onRerunPrompt: (prompt: string) => void;
  onClearHistory: () => void;
  onOpenSettings: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
}

export function ChatInput({
  onSend,
  onCancel,
  isGenerating,
  awaitingApproval = false,
  context,
  promptHistory,
  onRerunPrompt,
  onClearHistory,
  onOpenSettings,
  isDark,
  onToggleTheme,
}: ChatInputProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [value, setValue] = useState("");
  const [model, setModel] = useState(MODELS[0].id);
  const [modelOpen, setModelOpen] = useState(false);
  // Voice input: mic → record → transcribe → append to the prompt.
  const voice = useVoiceInput((text) => setValue((v) => (v.trim() ? `${v.trim()} ${text}` : text)));
  const currentModel = MODELS.find((m) => m.id === model) ?? MODELS[0];
  // Account UI comes from context (workspace switcher in prod, nothing in dev) — keeps
  // @supabase out of this always-loaded component. canGenerate gates the
  // input on the monthly quota; dev-bypass is never gated.
  const { accountSlot, canGenerate, isDev, upgrade } = useAccount();
  const quotaBlocked = !isDev && !canGenerate;

  const handleSubmit = useCallback(
    (message: PromptInputMessage) => {
      const trimmed = message.text.trim();
      if (!trimmed) return;
      onSend(trimmed, model);
      setValue("");
    },
    [onSend, model],
  );

  // Escape cancels a running generation or clears the draft (Enter/Shift+Enter
  // are handled by PromptInputTextarea).
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (isGenerating) onCancel();
        else setValue("");
      }
    },
    [isGenerating, onCancel],
  );

  return (
    <div className="px-3 py-2" data-tour-step-id="chat-input">
      {quotaBlocked && (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-destructive/20 bg-destructive/[0.05] px-3 py-2">
          <p className="text-[11px] leading-relaxed text-destructive/80">
            You've reached your monthly generation limit. Upgrade to Pro to keep generating.
          </p>
          <Button
            size="sm"
            type="button"
            className="h-7 shrink-0 gap-1.5 text-xs"
            onClick={() => upgrade()}
          >
            <CreditCard className="size-3" />
            Upgrade
          </Button>
        </div>
      )}
      <PromptInput onSubmit={handleSubmit}>
        <PromptInputBody>
          <PromptInputTextarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              quotaBlocked
                ? "Monthly limit reached — upgrade to Pro to keep generating."
                : awaitingApproval
                  ? 'Approve this action? Type "yes" or "no", or use the buttons above…'
                  : isGenerating
                    ? "Type a follow-up message..."
                    : "Describe the resource to generate..."
            }
          />
        </PromptInputBody>

        <PromptInputFooter>
          <PromptInputTools>
            {/* Account (prod: workspace switcher; dev: none) */}
            {accountSlot}

            {/* Voice input: record → transcribe → append to the prompt */}
            <PromptInputButton
              tooltip={voice.recording ? "Stop & transcribe" : "Voice input"}
              onClick={voice.toggle}
              disabled={voice.transcribing}
              className={voice.recording ? "text-destructive" : undefined}
            >
              {voice.transcribing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : voice.recording ? (
                <Square className="size-4 animate-pulse fill-current" />
              ) : (
                <Mic className="size-4" />
              )}
            </PromptInputButton>

            {/* Model selector — searchable command palette; wired to the agent via onSend */}
            <ModelSelector open={modelOpen} onOpenChange={setModelOpen}>
              <ModelSelectorTrigger asChild>
                <PromptInputButton tooltip="Select model" className="gap-1.5 text-xs">
                  <ModelSelectorLogo provider={currentModel.provider} />
                  {currentModel.label}
                </PromptInputButton>
              </ModelSelectorTrigger>
              <ModelSelectorContent title="Select a model">
                <ModelSelectorInput placeholder="Search models…" />
                <ModelSelectorList>
                  <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
                  {[{ heading: "Anthropic", items: ANTHROPIC_MODELS }].map((group) => (
                    <ModelSelectorGroup key={group.heading} heading={group.heading}>
                      {group.items.map((m) => (
                        <ModelSelectorItem
                          key={m.id}
                          value={m.id}
                          onSelect={() => {
                            setModel(m.id);
                            setModelOpen(false);
                          }}
                          className="gap-2 data-[selected=true]:bg-transparent data-[selected=true]:text-foreground"
                        >
                          <ModelSelectorLogo provider={m.provider} />
                          <ModelSelectorName>{m.label}</ModelSelectorName>
                        </ModelSelectorItem>
                      ))}
                    </ModelSelectorGroup>
                  ))}
                </ModelSelectorList>
              </ModelSelectorContent>
            </ModelSelector>

            {/* History */}
            {promptHistory.length > 0 && (
              <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
                <PopoverTrigger asChild>
                  <PromptInputButton tooltip="Prompt history">
                    <History className="size-4" />
                  </PromptInputButton>
                </PopoverTrigger>
                <PopoverContent className="w-80 p-0" align="end">
                  <div className="flex items-center justify-between border-b border-border-subtle/40 px-3 py-2">
                    <span className="font-mono text-xs font-semibold uppercase text-muted-foreground">
                      Prompt History
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      type="button"
                      className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        onClearHistory();
                        setHistoryOpen(false);
                      }}
                    >
                      <Trash2 className="mr-1 h-3 w-3" />
                      Clear
                    </Button>
                  </div>
                  <div className="max-h-64 overflow-y-auto">
                    {promptHistory.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
                        onClick={() => {
                          onRerunPrompt(entry.prompt);
                          setHistoryOpen(false);
                        }}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-xs text-foreground">
                            {entry.prompt.length > 60
                              ? `${entry.prompt.slice(0, 60)}...`
                              : entry.prompt}
                          </p>
                          <div className="mt-0.5 flex items-center gap-2">
                            <span className="font-mono text-[10px] text-muted-foreground">
                              {formatRelativeTime(entry.timestamp)}
                            </span>
                            {entry.resourceName && (
                              <Badge variant="secondary" className="h-4 px-1 font-mono text-[10px]">
                                {entry.resourceName}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}

            {/* Server context */}
            <Popover>
              <PopoverTrigger asChild>
                <PromptInputButton tooltip="Server context">
                  <SlidersVertical className="size-4" />
                </PromptInputButton>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-4" align="end">
                <div className="space-y-3">
                  <div className="font-mono text-xs font-semibold uppercase text-muted-foreground">
                    Server Context
                  </div>
                  <ContextBadges context={context} />
                </div>
              </PopoverContent>
            </Popover>

            {/* Settings + theme */}
            <Popover>
              <PopoverTrigger asChild>
                <PromptInputButton tooltip="Settings & theme">
                  <Settings className="size-4" />
                </PromptInputButton>
              </PopoverTrigger>
              <PopoverContent className="w-72 p-0" align="end">
                <div className="border-b border-border-subtle/40 px-3 py-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    className="w-full cursor-pointer justify-start gap-2 font-mono text-xs"
                    onClick={onOpenSettings}
                  >
                    <Settings className="size-3.5" />
                    App Settings
                  </Button>
                </div>
                <div className="grid gap-3 p-3">
                  <PresetSelector />
                  <ThemeScaleSelector />
                  <ThemeRadiusSelector />
                  <ColorModeSelector isDark={isDark} onToggleTheme={onToggleTheme} />
                  <ResetThemeButton />
                </div>
              </PopoverContent>
            </Popover>

            <div className="flex-1" />
          </PromptInputTools>

          {/* Send (Enter) / Stop while generating */}
          <PromptInputSubmit
            status={isGenerating ? "streaming" : "ready"}
            onStop={onCancel}
            disabled={(!isGenerating && !value.trim()) || quotaBlocked}
          />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
