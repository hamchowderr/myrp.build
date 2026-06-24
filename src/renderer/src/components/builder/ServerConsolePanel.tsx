import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import type { ConsoleEntry } from "@renderer/lib/types";
import { cn } from "@renderer/lib/utils";
import Anser from "anser";
import { Terminal, Trash2 } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef } from "react";

interface ServerConsolePanelProps {
  entries: ConsoleEntry[];
  onClear: () => void;
}

/** Base text color per stream when a chunk carries no ANSI foreground of its own. */
function sourceClass(source: ConsoleEntry["source"]): string {
  switch (source) {
    case "stderr":
      return "text-red-400/90";
    case "system":
      return "text-text-dim italic";
    default:
      return "text-text-secondary";
  }
}

/** Strip FiveM ^0-^9 / ^* codes that anser passes through as literal text. */
function stripFivem(text: string): string {
  return text.replace(/\^[0-9*]/g, "");
}

interface AnsiSpan {
  text: string;
  style: CSSProperties;
}

/** Parse one raw line (ANSI SGR codes) into styled spans for a dark terminal. */
function parseAnsi(raw: string): AnsiSpan[] {
  const chunks = Anser.ansiToJson(raw, {
    json: true,
    use_classes: false,
    remove_empty: true,
  });
  return chunks
    .map((c): AnsiSpan => {
      const style: CSSProperties = {};
      if (c.fg) style.color = `rgb(${c.fg})`;
      if (c.bg) style.backgroundColor = `rgb(${c.bg})`;
      const decos = c.decorations ?? [];
      if (decos.includes("bold")) style.fontWeight = 600;
      if (decos.includes("dim")) style.opacity = 0.6;
      if (decos.includes("italic")) style.fontStyle = "italic";
      const line: string[] = [];
      if (decos.includes("underline")) line.push("underline");
      if (decos.includes("strikethrough")) line.push("line-through");
      if (line.length > 0) style.textDecoration = line.join(" ");
      return { text: stripFivem(c.content), style };
    })
    .filter((s) => s.text.length > 0);
}

export function ServerConsolePanel({ entries, onClear }: ServerConsolePanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  // Precompute the colored spans once per entries change (cheap for ≤500 lines).
  const rendered = useMemo(
    () =>
      entries.map((e) => ({
        id: e.id,
        source: e.source,
        spans: parseAnsi(e.raw ?? e.text),
      })),
    [entries],
  );

  // Track whether the user has scrolled up so we don't yank them to the bottom.
  useEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector("[data-radix-scroll-area-viewport]");
    if (!viewport) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport as HTMLElement;
      userScrolledUp.current = scrollHeight - scrollTop - clientHeight > 40;
    };

    viewport.addEventListener("scroll", handleScroll);
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll to bottom as new lines stream in (unless the user scrolled up).
  useEffect(() => {
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, []);

  return (
    <div className="flex h-full flex-col bg-deep">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border-subtle/40 bg-surface px-3">
        <div className="flex items-center gap-2 text-text-dim">
          <Terminal className="size-3.5" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em]">Console</span>
          {entries.length > 0 && (
            <span className="font-mono text-[10px] text-text-dim/50">{entries.length}</span>
          )}
        </div>
        {entries.length > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-text-dim hover:text-text-primary"
            onClick={onClear}
            title="Clear console"
          >
            <Trash2 className="size-3" />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <ScrollArea className="h-full" ref={scrollAreaRef}>
          <div className="p-2 font-mono text-xs leading-relaxed">
            {rendered.length === 0 ? (
              <p className="p-1 text-text-dim">Start FXServer to see console output</p>
            ) : (
              rendered.map((row) => (
                <div
                  key={row.id}
                  className={cn(
                    "whitespace-pre-wrap break-all px-1 py-px",
                    sourceClass(row.source),
                  )}
                >
                  {row.spans.length === 0
                    ? " "
                    : row.spans.map((s, i) => (
                        <span key={`${row.id}-${i}`} style={s.style}>
                          {s.text}
                        </span>
                      ))}
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
