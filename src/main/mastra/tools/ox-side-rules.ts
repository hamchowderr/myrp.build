/**
 * Script-side rules for generated ox_overextended Lua: does `lib.*` actually load,
 * and is each ox_lib function called on the side where it exists?
 *
 * Measured live (2026-11-28, a one-line `/ping` request on Mastra 1.86): the agent
 * wrote `lib.addCommand` in `client/main.lua` and a manifest with
 * `dependency 'ox_lib'` but no `@ox_lib/init.lua`. Both are runtime crashes
 * (`attempt to index a nil value (global 'lib')`, and `lib.addCommand` is
 * server-only), and the validator reported 0 errors, because it accepted the
 * dependency line as "ox_lib is loaded".
 *
 * `dependency 'ox_lib'` only orders resource start. The `lib` global exists only in
 * the script environments that load `@ox_lib/init.lua` (shared_scripts covers both
 * sides; client_scripts / server_scripts cover one).
 *
 * Same zero-false-positive contract as lua-rules.ts: the function lists hold only
 * functions ox_lib defines on ONE side, and a file whose side can't be determined
 * is skipped rather than guessed.
 */
import type { ValidationIssue } from "./validator";

export type ScriptSide = "client" | "server" | "shared";

const OX_INIT = "@ox_lib/init.lua";

/** ox_lib functions that exist only in the server environment. */
const SERVER_ONLY = [
  "addCommand",
  "addAce",
  "removeAce",
  "addPrincipal",
  "removePrincipal",
  "versionCheck",
];

/** ox_lib functions that exist only in the client environment (UI, streaming, input). */
const CLIENT_ONLY = [
  "registerContext",
  "showContext",
  "hideContext",
  "inputDialog",
  "alertDialog",
  "progressBar",
  "progressCircle",
  "showTextUI",
  "hideTextUI",
  "registerMenu",
  "showMenu",
  "addKeybind",
  "skillCheck",
  "registerRadial",
  "addRadialItem",
  "requestModel",
  "requestAnimDict",
];

/** Drop `--` line comments and `--[[ ]]` block comments so commented code never trips a rule. */
function stripComments(lua: string): string {
  return lua.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, "").replace(/--[^\n]*/g, "");
}

function callsAny(code: string, fns: string[]): string[] {
  return fns.filter((fn) => new RegExp(`\\blib\\.${fn}\\s*\\(`).test(code));
}

/**
 * Which side each declared script runs on, keyed by resource-relative path.
 * `entries(keys)` is the validator's manifest reader.
 */
export function scriptSides(entries: (keys: string[]) => string[]): {
  sideOf: Map<string, ScriptSide>;
  initOn: Set<ScriptSide>;
} {
  const sideOf = new Map<string, ScriptSide>();
  const initOn = new Set<ScriptSide>();
  const groups: [ScriptSide, string[]][] = [
    ["shared", entries(["shared_scripts", "shared_script"])],
    ["client", entries(["client_scripts", "client_script"])],
    ["server", entries(["server_scripts", "server_script"])],
  ];
  for (const [side, list] of groups) {
    for (const entry of list) {
      if (entry === OX_INIT) initOn.add(side);
      else if (!entry.startsWith("@")) sideOf.set(entry.replace(/\\/g, "/"), side);
    }
  }
  return { sideOf, initOn };
}

/** A file's side from the manifest, else from a conventional `client/` or `server/` folder. */
export function sideFor(rel: string, sideOf: Map<string, ScriptSide>): ScriptSide | undefined {
  const declared = sideOf.get(rel);
  if (declared) return declared;
  if (/^client\//.test(rel)) return "client";
  if (/^server\//.test(rel)) return "server";
  return undefined;
}

/** Does `lib` exist in this side's environment? */
function libLoaded(side: ScriptSide, initOn: Set<ScriptSide>): boolean {
  if (initOn.has("shared")) return true;
  if (side === "shared") return initOn.has("client") && initOn.has("server");
  return initOn.has(side);
}

/**
 * Scan ONE .lua file for side errors.
 *
 * @param rel     resource-relative path, used as the issue's `file`
 * @param content the file's source
 * @param side    where the file runs, or undefined when it can't be told
 * @param initOn  the sides whose script list loads `@ox_lib/init.lua`
 */
export function oxSideIssues(
  rel: string,
  content: string,
  side: ScriptSide | undefined,
  initOn: Set<ScriptSide>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const code = stripComments(content);
  if (!side || !/\blib\.[A-Za-z]/.test(code)) return issues;

  if (!libLoaded(side, initOn)) {
    issues.push({
      severity: "error",
      message: `${rel} calls lib.* but '${OX_INIT}' is not loaded on the ${side} side, so 'lib' is nil at runtime — add shared_scripts { '${OX_INIT}' } to fxmanifest.lua (dependency 'ox_lib' only orders startup, it does not load lib)`,
      file: rel,
    });
  }

  // Shared files are skipped: they often guard side-specific calls with
  // IsDuplicityVersion(), which a static scan can't follow.
  if (side === "client") {
    for (const fn of callsAny(code, SERVER_ONLY)) {
      issues.push({
        severity: "error",
        message: `lib.${fn} is server-only, but ${rel} runs on the ${side} side — move it to a server script (e.g. lib.addCommand belongs in server/main.lua; notify the player with TriggerClientEvent('ox_lib:notify', source, { ... }))`,
        file: rel,
      });
    }
  }
  if (side === "server") {
    for (const fn of callsAny(code, CLIENT_ONLY)) {
      issues.push({
        severity: "error",
        message: `lib.${fn} is client-only, but ${rel} runs on the ${side} side — move it to a client script`,
        file: rel,
      });
    }
  }
  return issues;
}
