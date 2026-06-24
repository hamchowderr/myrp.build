import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScorer } from "@mastra/core/evals";
import { extractLua, type GeneratedFile } from "./shared";

// Does the generated Lua pass luacheck (syntax-level)? We run luacheck on each
// Lua source and pass a file when luacheck reports zero ERRORS (syntax). Style
// warnings (undefined FiveM globals, unused vars, line length) are ignored — we
// only care that the Lua is structurally valid. Score = passing / total.
// Skips gracefully (1.0) when luacheck isn't installed or no Lua was generated;
// the reason makes the skip explicit so it never silently masquerades as a pass.
const LUACHECK = process.env.LUACHECK_PATH ?? "luacheck";

interface LuaResult {
  path: string;
  ok: boolean;
  detail: string;
}

function runLuacheck(files: GeneratedFile[]): { results: LuaResult[]; available: boolean } {
  if (files.length === 0) return { results: [], available: true };
  const dir = mkdtempSync(join(tmpdir(), "studio-luacheck-"));
  try {
    const results: LuaResult[] = [];
    for (const [i, f] of files.entries()) {
      const tmp = join(dir, `f${i}.lua`);
      writeFileSync(tmp, f.content, "utf8");
      const proc = spawnSync(LUACHECK, ["--codes", "--formatter", "plain", tmp], {
        encoding: "utf8",
      });
      if (proc.error && (proc.error as NodeJS.ErrnoException).code === "ENOENT") {
        return { results: [], available: false };
      }
      const out = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
      // luacheck plain summary: "Total: N warnings / M errors in K files".
      const m = out.match(/(\d+)\s+errors?\b/);
      const errorCount = m ? Number.parseInt(m[1], 10) : (proc.status ?? 0) >= 2 ? 1 : 0;
      const errLines = [...out.matchAll(/\(E\d{3}\)[^\n]*/g)].map((x) => x[0].trim());
      results.push({
        path: f.path,
        ok: errorCount === 0,
        detail: errLines.slice(0, 2).join("; "),
      });
    }
    return { results, available: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const luacheckPassScorer = createScorer({
  id: "luacheck-pass",
  name: "luacheck pass",
  description:
    "Runs luacheck on the generated Lua and scores the share of files with no syntax errors.",
  type: "agent",
})
  .analyze(({ run }) => {
    const lua = extractLua(run.output);
    const { results, available } = runLuacheck(lua);
    return { available, total: lua.length, results };
  })
  .generateScore(({ results }) => {
    const a = results.analyzeStepResult;
    if (!a.available || a.total === 0) return 1; // skip — non-penalizing
    const passed = a.results.filter((r) => r.ok).length;
    return passed / a.total;
  })
  .generateReason(({ results }) => {
    const a = results.analyzeStepResult;
    if (!a.available) return "luacheck not found on PATH (set LUACHECK_PATH) — skipped.";
    if (a.total === 0) return "No Lua generated to check — skipped.";
    const failed = a.results.filter((r) => !r.ok);
    if (failed.length === 0)
      return `All ${a.total} Lua file(s) passed luacheck (no syntax errors).`;
    return `${a.total - failed.length}/${a.total} Lua file(s) passed. Errors in: ${failed
      .map((f) => `${f.path}${f.detail ? ` [${f.detail}]` : ""}`)
      .join(", ")}.`;
  });
