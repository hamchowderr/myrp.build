/**
 * Pure console-scan logic for the deploy smoke-test (fivem-studio-m7f).
 *
 * Split out from smoke-test.ts so it has ZERO runtime imports (only a type-only
 * import, erased at compile) and can be unit-tested without pulling in
 * shared-state / koffi / dgram. smoke-test.ts does the I/O (RCON + console poll)
 * and calls scanConsoleForLoadErrors here.
 */
import type { ConsoleEntry } from "./fxdk/session";

/**
 * FiveM (^0-^9 / ^*) + ANSI color codes — the raw console buffer keeps them.
 * The ANSI ESC (U+001B) is built via String.fromCharCode so there's no literal
 * control char in the regex source (Biome noControlCharactersInRegex).
 */
const COLOR_RE = new RegExp(`\\^[0-9*]|${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (s: string): string => s.replace(COLOR_RE, "");

/** Curated FXServer stdout patterns that mean a resource failed to load. */
export const LOAD_ERROR_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /couldn'?t start resource/i, label: "resource failed to start" },
  { re: /could(n'?t| not) find dependency/i, label: "missing dependency" },
  { re: /\bSCRIPT ERROR\b/i, label: "Lua script error" },
  { re: /error (loading|parsing|while running)/i, label: "load/parse error" },
  { re: /failed to (load|start)/i, label: "failed to load/start" },
  { re: /unexpected symbol|'<eof>'|near '|syntax error/i, label: "Lua syntax error" },
  { re: /^\s*\[\s*ERROR\s*\]/im, label: "error log line" },
];

export interface ConsoleScanResult {
  loadSuccess: boolean;
  /** True if we saw an explicit "Started resource <name>" confirmation. */
  startedConfirmed: boolean;
  loadError?: string;
  matchedPattern?: string;
  snippet?: string[];
}

/**
 * Scan console lines (those produced after `ensure`) for this resource's load
 * result. Returns the first load error found, plus whether a positive start
 * confirmation appeared. Pure — no I/O.
 */
export function scanConsoleForLoadErrors(
  entries: ConsoleEntry[],
  resourceName: string,
): ConsoleScanResult {
  const lines = entries.map((e) => strip(e.text));
  const startedRe = new RegExp(
    `started resource\\s+${resourceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "i",
  );
  let startedConfirmed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (startedRe.test(line)) startedConfirmed = true;
    for (const { re, label } of LOAD_ERROR_PATTERNS) {
      if (re.test(line)) {
        return {
          loadSuccess: false,
          startedConfirmed,
          loadError: `${label}: ${line.trim().slice(0, 240)}`,
          matchedPattern: re.source,
          snippet: lines.slice(Math.max(0, i - 1), i + 4).map((l) => l.trim()),
        };
      }
    }
  }
  return { loadSuccess: true, startedConfirmed };
}
