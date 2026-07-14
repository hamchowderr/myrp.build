/**
 * Interactive ask_user / submit_plan suspension card. When a
 * Harness turn parks on ask_user it emits `tool_suspended` (with a suspendPayload)
 * and the run idles; this card lets the user answer, which calls
 * useHarnessChat.respondSuspension → window.api.harness.respondSuspension →
 * session.respondToToolSuspension, resuming the SAME run (persistent session).
 *
 * suspendPayload = { question?, options?, selectionMode? }; the resume answer is
 * an AskUserAnswer (string for free-text / single-choice, string[] for multi).
 */

import { Button } from "@renderer/components/ui/button";
import type { PendingSuspension } from "@renderer/lib/harness/events";
import { cn } from "@renderer/lib/utils";
import { useEffect, useRef, useState } from "react";

type SuspendPayload = {
  question?: string;
  options?: Array<string | { label?: string; value?: string }>;
  selectionMode?: "single" | "multiple";
};

function normalizeOptions(options: SuspendPayload["options"]): { label: string; value: string }[] {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) =>
      typeof o === "string"
        ? { label: o, value: o }
        : { label: o.label ?? o.value ?? "", value: o.value ?? o.label ?? "" },
    )
    .filter((o) => o.value !== "");
}

export function SuspensionCard({
  suspension,
  disabled,
  onRespond,
}: {
  suspension: PendingSuspension;
  disabled?: boolean;
  onRespond: (answer: string | string[], toolCallId: string) => void;
}): React.JSX.Element {
  const payload = (suspension.suspendPayload ?? {}) as SuspendPayload;
  const question = payload.question ?? "The agent needs your input to continue.";
  const options = normalizeOptions(payload.options);
  const multiple = payload.selectionMode === "multiple";
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the answer field as soon as the agent asks (programmatic, not autoFocus).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (answer: string | string[]): void => {
    if (disabled) return;
    onRespond(answer, suspension.toolCallId);
  };

  return (
    <div className="mx-auto w-full max-w-[720px] rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-xs">
      <p className="mb-2 font-medium text-foreground">{question}</p>

      {options.length === 0 ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) submit(text.trim());
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type your answer…"
            className="flex-1 rounded-md border border-border-subtle bg-background px-2 py-1.5 text-foreground outline-none focus:border-sky-500"
          />
          <Button
            type="submit"
            size="sm"
            className="h-7 text-xs"
            disabled={disabled || !text.trim()}
          >
            Send
          </Button>
        </form>
      ) : multiple ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {options.map((o) => {
              const on = selected.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  disabled={disabled}
                  onClick={() =>
                    setSelected((s) => (on ? s.filter((v) => v !== o.value) : [...s, o.value]))
                  }
                  className={cn(
                    "rounded-full border px-3 py-1 transition-colors",
                    on
                      ? "border-sky-500 bg-sky-500/20 text-foreground"
                      : "border-border-subtle text-muted-foreground hover:border-text-dim",
                  )}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          <div>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={disabled || selected.length === 0}
              onClick={() => submit(selected)}
            >
              Submit
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => (
            <Button
              key={o.value}
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={disabled}
              onClick={() => submit(o.value)}
            >
              {o.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
