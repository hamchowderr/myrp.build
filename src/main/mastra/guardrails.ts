/**
 * Deterministic input guardrails (aku) — defense-in-depth, NOT the primary control.
 *
 * The exec approval gate (applyFiveMPermissions) is and stays the primary,
 * source-agnostic control on the live FXServer + shell: it intercepts the actual
 * tool CALL regardless of where the command came from — the user prompt, a
 * poisoned third-party resource file the agent reads mid-run, or a RAG snippet.
 * An INPUT processor only sees the USER message before the LLM, so it CANNOT see
 * a command the agent reads mid-run — which is exactly our worst injection
 * vector. So this layer is cheap belt-and-suspenders for the naive "user pastes /
 * asks for a destructive command" case, nothing more.
 *
 * The rules match only UNAMBIGUOUSLY destructive shell invocations — patterns with
 * no legitimate place in an ox_overextended resource-generation request — to keep
 * false positives near zero. `strategy: "block"` (a hard TripWire stop) is
 * appropriate because a match is never a real generation request; the user simply
 * rephrases.
 *
 * DECISION (aku): PromptInjectionDetector is NOT enabled. It is an LLM classifier
 * that adds a full model round-trip of latency + cost to EVERY turn of a
 * generation app whose real control is the source-agnostic approval gate — a poor
 * trade for a naive-input case this deterministic filter already covers for free.
 * Revisit only if we observe real in-prompt injection attempts in the wild.
 */
import type { RegexRule } from "@mastra/core/processors";

/**
 * Unambiguously catastrophic shell commands. Scoped tightly (root / home / current
 * dir / wildcard / raw block device / drive format) so ordinary generation prompts
 * — including ones that mention `rm`, `del`, or `format` in prose — don't trip.
 */
export const DANGEROUS_SHELL_RULES: RegexRule[] = [
  // rm -rf (either flag ordering) targeting root, home, current dir, or a wildcard.
  // Deeper paths like `rm -rf /home/foo` are intentionally NOT matched — only the
  // catastrophic whole-tree targets are.
  {
    name: "rm-rf-destructive",
    pattern: /\brm\s+-\S*[rf]\S*\s+(?:-\S+\s+)*(?:\/|~|\/\*|\*|\.)(?:\s|;|&|$)/i,
  },
  // Classic fork bomb :(){ :|:& };:
  { name: "fork-bomb", pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:?\s*&?\s*\}\s*;\s*:/ },
  // Raw-disk overwrite via dd onto a block device.
  { name: "disk-overwrite", pattern: /\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|hd|disk|mmcblk)/i },
  // Filesystem format on a device node.
  { name: "mkfs-device", pattern: /\bmkfs(?:\.\w+)?\s+\/dev\/\S+/i },
  // Redirect into a raw block device (> /dev/sda).
  { name: "device-clobber", pattern: />\s*\/dev\/(?:sd|nvme|hd)[a-z0-9]+/i },
  // Windows: format a drive (bare or with a switch), not prose mentioning "format".
  { name: "windows-format-drive", pattern: /\bformat\s+[a-z]:\s*(?:\/|$)/i },
  // Windows: recursive force-delete of a drive root (del /f /s /q C:\).
  { name: "windows-force-del-root", pattern: /\bdel\s+(?:\/[a-z]\s+)*[a-z]:\\/i },
  // Windows: rmdir /s of a drive root.
  { name: "windows-rmdir-root", pattern: /\b(?:rd|rmdir)\s+\/s\s+(?:\/q\s+)?[a-z]:\\/i },
];
