import type { ConsoleEntry } from "@renderer/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";

const MAX_ENTRIES = 500;

/** Strip FiveM ^0-^9/^* color codes AND full ANSI escape sequences */
function stripColorCodes(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) is intentional — stripping ANSI SGR sequences
      .replace(/\x1b\[[0-9;]*m/g, "") // ANSI SGR sequences (colors, bold, etc.)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (\x1b) is intentional — stripping ANSI escape sequences
      .replace(/\x1b\[\d*[A-Za-z]/g, "") // Other ANSI escape sequences
      .replace(/\^\d|\^\*/g, "")
  ); // FiveM ^0-^9 and ^* codes
}

export function useServerConsole() {
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Load existing buffer on mount
    window.api.getConsoleBuffer().then((buffer) => {
      if (buffer.length > 0) {
        setEntries(buffer.map((e) => ({ ...e, raw: e.text, text: stripColorCodes(e.text) })));
      }
    });

    // Subscribe to live console events
    cleanupRef.current = window.api.onServerConsole((entry) => {
      const cleaned: ConsoleEntry = {
        ...entry,
        raw: entry.text,
        text: stripColorCodes(entry.text),
      };
      setEntries((prev) => {
        const next = [...prev, cleaned];
        return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
      });
    });

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
  }, []);

  return { entries, clear, isActive: entries.length > 0 };
}
