/**
 * Static validator tool for generated ox_overextended resources.
 *
 * Deterministic, zero-false-positive checks the agent runs in its VERIFY step
 * so it can self-repair before finishing. Catches the highest-frequency
 * generation bugs:
 *   - fxmanifest missing / wrong fx_version
 *   - files declared in fxmanifest that don't exist on disk (the classic
 *     "client.lua" vs "client/main.lua" mismatch)
 *   - orphan .lua/.html files not declared in the manifest
 *   - forbidden patterns (GetPlayerPed(-1), mysql-async, __resource.lua)
 *   - backtick/template-literal strings — always a Lua syntax error (E011)
 *   - ox_lib not declared as a dependency (required for every ox resource)
 *
 * These pure-JS checks have no external dependency and never false-positive. On top
 * of them, two real Lua engines gate syntax/semantics when their (bundled) binaries
 * resolve: luacheck (E0xx syntax) and lua-language-server --check (Error-level) —
 * the Mastra LSP-client URI bug that once blocked LuaLS is fixed upstream (#17813), so
 * the Workspace also runs LuaLS as an in-loop LSP now (mastra/workspace.ts). Both gates
 * degrade gracefully when the binary is missing.
 * The backtick check is the one syntax check cheap enough to do
 * here losslessly: backticks are never valid Lua tokens, so a string/comment-aware
 * scan for a stray ` is zero-false-positive and catches the model's single most
 * common JS-ism, which the post-hoc luacheck scorer kept flagging as E011.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import log from "../log";

const LOCAL_DIR = "[local]";

export interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
  file?: string;
}

/**
 * True if a .lua file uses a JS backtick/template-literal string — always a Lua
 * syntax error (luacheck E011 "expected expression near '`'"), the model's single
 * most common JS-ism. String/comment-aware so a backtick *inside* a legitimate Lua
 * string or comment never false-positives (honoring this layer's zero-FP promise).
 */
export function usesBacktickString(lua: string): boolean {
  const n = lua.length;
  // If `open` starts a long bracket ([[ / [=[ ), return the index past its match
  // (]] / ]=] ), else -1. Used to skip long strings AND --[[ ]] block comments.
  const skipLongBracket = (open: number): number => {
    if (lua[open] !== "[") return -1;
    let j = open + 1;
    let eq = 0;
    while (lua[j] === "=") {
      eq++;
      j++;
    }
    if (lua[j] !== "[") return -1;
    const close = `]${"=".repeat(eq)}]`;
    const end = lua.indexOf(close, j + 1);
    return end === -1 ? n : end + close.length;
  };

  let i = 0;
  while (i < n) {
    const c = lua[i];
    if (c === "-" && lua[i + 1] === "-") {
      const after = skipLongBracket(i + 2); // --[[ block comment?
      if (after !== -1) {
        i = after;
      } else {
        i += 2;
        while (i < n && lua[i] !== "\n") i++; // -- line comment
      }
      continue;
    }
    if (c === "[") {
      const after = skipLongBracket(i);
      if (after !== -1) {
        i = after;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < n && lua[i] !== quote) {
        if (lua[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "`") return true; // backtick outside any string/comment = E011
    i++;
  }
  return false;
}

/**
 * Run luacheck (when available) over the resource dir and return ERROR-level
 * (syntax) issues only — the real Lua syntax gate. Graceful:
 * resolves to [] when luacheck isn't installed, so the validator never hard-depends
 * on it (pure-JS checks remain the universal net). Warnings (undefined FiveM
 * globals, unused vars, style) are intentionally ignored — only syntax errors block.
 * Non-blocking spawn so it never freezes the Electron main process during generation.
 */
function luacheckSyntaxErrors(dir: string): Promise<ValidationIssue[]> {
  return new Promise((resolve_) => {
    let proc: ReturnType<typeof spawn>;
    try {
      // LUACHECK_PATH is set by main to the asar-unpacked bundled binary in packaged
      // builds; in dev it falls back to luacheck on PATH.
      const bin = process.env.LUACHECK_PATH || "luacheck";
      proc = spawn(bin, [dir, "--formatter", "plain", "--codes", "--no-color"], {
        windowsHide: true,
      });
    } catch {
      resolve_([]);
      return;
    }
    let out = "";
    proc.on("error", () => resolve_([])); // ENOENT = luacheck not installed → skip
    proc.stdout?.on("data", (d) => {
      out += d;
    });
    const timer = setTimeout(() => {
      proc.kill();
      resolve_(parseLuacheckErrors(out, dir));
    }, 15_000);
    proc.on("close", () => {
      clearTimeout(timer);
      resolve_(parseLuacheckErrors(out, dir));
    });
  });
}

/** Parse `file:line:col: (E0xx) message` lines from luacheck --formatter plain.
 *  Only E-prefixed codes (syntax errors) become issues; W-codes are ignored. */
function parseLuacheckErrors(stdout: string, dir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^(.*\.lua):(\d+):(\d+):\s+\((E\d+)\)\s+(.*?)\s*$/);
    if (!m) continue;
    const [, file, ln, col, code, msg] = m;
    const rel = relative(dir, file).replace(/\\/g, "/");
    issues.push({
      severity: "error",
      message: `Lua syntax error (luacheck ${code}) at ${ln}:${col} — ${msg}`,
      file: rel || file,
    });
  }
  return issues;
}

/**
 * Run lua-language-server --check over the resource dir and return ERROR-level
 * diagnostics only. At --checklevel=Error LuaLS reports genuine syntax/semantic
 * errors but NOT the undefined-global WARNINGS every FiveM native would trip
 * (exports/lib/Citizen/vector3/GetPlayerPed/… aren't in LuaLS's known globals) — that
 * exclusion IS the calibrated gate, so it complements luacheck without drowning the
 * agent in false positives. Graceful: skips when LUALS_PATH is unset/missing (main
 * resolves the bundled binary). --logpath is a throwaway temp dir so LuaLS never writes
 * into its install tree (read-only in a packaged build). Non-blocking, capped spawn.
 */
export function luaLsCheckErrors(dir: string): Promise<ValidationIssue[]> {
  const bin = process.env.LUALS_PATH;
  if (!bin || !existsSync(bin)) return Promise.resolve([]);
  return new Promise((resolve_) => {
    const logPath = mkdtempSync(join(tmpdir(), "luals-check-"));
    const finish = (out: string) => {
      rmSync(logPath, { recursive: true, force: true });
      resolve_(parseLuaLsErrors(out, dir));
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(bin, ["--check", dir, "--checklevel=Error", `--logpath=${logPath}`], {
        windowsHide: true,
      });
    } catch {
      finish("");
      return;
    }
    let out = "";
    proc.on("error", () => finish("")); // spawn failure → skip (keep other gates)
    proc.stdout?.on("data", (d) => {
      out += d;
    });
    proc.stderr?.on("data", (d) => {
      out += d;
    });
    const timer = setTimeout(() => {
      proc.kill();
      finish(out);
    }, 25_000);
    proc.on("close", () => {
      clearTimeout(timer);
      finish(out);
    });
  });
}

/** Parse LuaLS `--check` output lines `<file>:<line>:<col> [Error] <message> (<code>)`.
 *  ANSI is stripped first; only [Error]-level lines become issues (warnings excluded). */
function parseLuaLsErrors(stdout: string, dir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR escapes
  const clean = stdout.replace(/\[[0-9;]*m/g, "");
  // Split on \r too: LuaLS overwrites its progress line with carriage returns, so the
  // diagnostic shares a \n-line with "Initializing …" and JS regex `.` won't cross \r.
  for (const line of clean.split(/[\r\n]+/)) {
    const m = line.match(/^\s*(.*?\.lua):(\d+):(\d+)\s+\[Error\]\s+(.*?)\s*\(([\w-]+)\)\s*$/);
    if (!m) continue;
    const [, file, ln, col, msg, code] = m;
    const rel = relative(dir, file).replace(/\\/g, "/");
    issues.push({
      severity: "error",
      message: `Lua error (lua-language-server ${code}) at ${ln}:${col} — ${msg}`,
      file: rel || file,
    });
  }
  return issues;
}

/** Extract quoted string entries from `key { '...', "..." }` or `key '...'` forms. */
function manifestEntries(manifest: string, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    // Block form: key { ... }
    const block = new RegExp(`${key}\\s*\\{([\\s\\S]*?)\\}`, "g");
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec iteration idiom
    while ((m = block.exec(manifest))) {
      for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) out.push(s[1]);
    }
    // Single form: key '...'
    const single = new RegExp(`${key}\\s+['"]([^'"]+)['"]`, "g");
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec iteration idiom
    while ((m = single.exec(manifest))) out.push(m[1]);
  }
  return out;
}

function isGlob(p: string): boolean {
  return /[*?[\]]/.test(p);
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(full);
    }
  };
  await walk(dir);
  return out;
}

export async function validateResource(
  resourcesRoot: string,
  resourceName: string,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const dir = resolve(resourcesRoot, LOCAL_DIR, resourceName);

  if (!existsSync(dir)) {
    return [{ severity: "error", message: `Resource folder not found: ${dir}` }];
  }

  // __resource.lua is never allowed.
  if (existsSync(join(dir, "__resource.lua"))) {
    issues.push({
      severity: "error",
      message: "__resource.lua is deprecated — use fxmanifest.lua",
      file: "__resource.lua",
    });
  }

  const manifestPath = join(dir, "fxmanifest.lua");
  if (!existsSync(manifestPath)) {
    issues.push({ severity: "error", message: "fxmanifest.lua is missing" });
    return issues;
  }
  const manifest = await readFile(manifestPath, "utf-8");

  if (!/fx_version\s+['"]cerulean['"]/.test(manifest)) {
    issues.push({
      severity: "error",
      message: "fxmanifest must declare fx_version 'cerulean'",
      file: "fxmanifest.lua",
    });
  }
  if (!/\bgame\s+['"]gta5['"]/.test(manifest)) {
    issues.push({
      severity: "warning",
      message: "fxmanifest should declare game 'gta5'",
      file: "fxmanifest.lua",
    });
  }

  // Declared script/file entries must exist on disk (skip @resource refs + globs).
  const declared = manifestEntries(manifest, [
    "client_scripts",
    "server_scripts",
    "shared_scripts",
    "client_script",
    "server_script",
    "shared_script",
    "files",
  ]);
  const localFiles = new Set<string>();
  for (const entry of declared) {
    if (entry.startsWith("@") || isGlob(entry)) continue; // @ox_lib/... or glob
    localFiles.add(entry.replace(/\\/g, "/"));
    if (!existsSync(resolve(dir, entry))) {
      issues.push({
        severity: "error",
        message: `fxmanifest declares '${entry}' but the file does not exist`,
        file: "fxmanifest.lua",
      });
    }
  }
  const uiPage = manifestEntries(manifest, ["ui_page"]);
  for (const entry of uiPage) {
    if (entry.startsWith("@") || isGlob(entry) || /^https?:/.test(entry)) continue;
    localFiles.add(entry.replace(/\\/g, "/"));
    if (!existsSync(resolve(dir, entry))) {
      issues.push({
        severity: "error",
        message: `ui_page '${entry}' does not exist`,
        file: "fxmanifest.lua",
      });
    }
  }

  // Orphan check + forbidden-pattern scan over .lua/.html on disk.
  const onDisk = await listFilesRecursive(dir);
  const usesOxLib = manifest.includes("@ox_lib/init.lua") || /['"]ox_lib['"]/.test(manifest);
  let referencesLib = false;
  for (const abs of onDisk) {
    const rel = relative(dir, abs).replace(/\\/g, "/");
    if (rel === "fxmanifest.lua") continue;
    const isScript = /\.(lua|html|js|css)$/.test(rel);
    if (!isScript) continue;

    if (
      (rel.endsWith(".lua") || rel.endsWith(".html")) &&
      !localFiles.has(rel) &&
      !declared.some((d) => isGlob(d)) // a glob may cover it — don't warn
    ) {
      issues.push({
        severity: "warning",
        message: `${rel} exists but is not declared in fxmanifest`,
        file: rel,
      });
    }

    if (rel.endsWith(".lua")) {
      const content = await readFile(abs, "utf-8");
      if (/GetPlayerPed\s*\(\s*-1\s*\)/.test(content)) {
        issues.push({
          severity: "error",
          message: "Use PlayerPedId() instead of GetPlayerPed(-1)",
          file: rel,
        });
      }
      if (/MySQL\.Async|mysql-async|exports\[['"]mysql-async['"]\]/.test(content)) {
        issues.push({
          severity: "error",
          message: "Use oxmysql, not mysql-async",
          file: rel,
        });
      }
      // Non-ox schema leak — ox_core's accounts table has no `bank`/`identifier`
      // columns. Scoped to the `accounts` table to keep false positives at zero.
      if (
        /SELECT[\s\S]{0,60}\bbank\b[\s\S]{0,60}FROM\s+`?accounts`?/i.test(content) ||
        /FROM\s+`?accounts`?[\s\S]{0,80}\bidentifier\b/i.test(content) ||
        /`?accounts`?\.`?bank`?\b/i.test(content)
      ) {
        issues.push({
          severity: "error",
          message:
            "Non-ox accounts schema detected (accounts.bank / accounts.identifier). This is ox_overextended: ox_core's accounts table is (owner=charId, balance) — read with \"SELECT balance FROM accounts WHERE owner = ? AND isDefault = 1\", or use exports.ox_core:GetPlayer(src):getAccount('bank').balance.",
          file: rel,
        });
      }
      if (usesBacktickString(content)) {
        issues.push({
          severity: "error",
          message:
            "Lua has no backtick/template-literal strings (syntax error E011) — quote with '...' or \"...\", and build/interpolate strings with the '..' operator or string.format()",
          file: rel,
        });
      }
      if (/\blib\./.test(content)) referencesLib = true;
    }
  }

  // Every ox resource MUST declare the ox_lib dependency — even config-only ones
  // (ox-only rule + the manifest-valid eval scorer). Error, not warning, so the
  // agent repairs it in its VERIFY step (it only acts on errors).
  if (!usesOxLib) {
    issues.push({
      severity: "error",
      message: referencesLib
        ? "Code uses ox_lib (lib.*) but fxmanifest doesn't load it — add shared_script '@ox_lib/init.lua' or dependency 'ox_lib'"
        : "fxmanifest must declare the ox_lib dependency (dependency 'ox_lib' or shared_script '@ox_lib/init.lua') — required for every ox resource, including config-only",
      file: "fxmanifest.lua",
    });
  }

  // Real Lua syntax/semantics gate — luacheck (E0xx) + lua-language-server --check
  // (Error-level) run concurrently; each catches what the pure-JS checks and the
  // other can't, and both no-op gracefully when their binary isn't resolved.
  const [luacheckIssues, lualsIssues] = await Promise.all([
    luacheckSyntaxErrors(dir),
    luaLsCheckErrors(dir),
  ]);
  issues.push(...luacheckIssues, ...lualsIssues);

  return issues;
}

/**
 * Build the `validate_resource` tool bound to the server's resources root. The
 * agent calls it in its VERIFY step and repairs any reported errors.
 */
export function createValidatorTool(resourcesRoot: string) {
  return createTool({
    id: "validate_resource",
    description:
      "Statically validate a generated ox_overextended resource: checks fxmanifest correctness + ox_lib dependency, that every declared file exists on disk, orphan files, forbidden patterns (GetPlayerPed(-1), non-ox DB drivers, __resource.lua, backtick/template-literal strings, non-ox schema like accounts.bank/identifier), and Lua syntax errors (via luacheck when available). Call this after writing all files; if it returns errors, fix them and call again (max 3 times).",
    inputSchema: z.object({
      resourceName: z
        .string()
        .describe("The resource folder name under [local]/, e.g. 'bank-balance'"),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      errorCount: z.number(),
      warningCount: z.number(),
      issues: z.array(
        z.object({
          severity: z.enum(["error", "warning"]),
          message: z.string(),
          file: z.string().optional(),
        }),
      ),
    }),
    execute: async (input) => {
      const issues = await validateResource(resourcesRoot, input.resourceName);
      const errorCount = issues.filter((i) => i.severity === "error").length;
      log.info(
        `[validate] ${input.resourceName}: ${errorCount} error(s), ${issues.length - errorCount} warning(s)`,
      );
      return {
        ok: errorCount === 0,
        errorCount,
        warningCount: issues.length - errorCount,
        issues,
      };
    },
  });
}
