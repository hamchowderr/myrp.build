#!/usr/bin/env node
// db-drift-check (fivem-studio-d6g) — catch "history says applied, body didn't run" drift.
//
// WHY a schema diff and not `supabase migration list`: the hosted GitHub integration
// records a migration *version* as applied even when its body didn't fully execute
// (esp. auth-schema triggers). A history check trusts that record — it's exactly what
// got fooled in the 2026-06-03 prod outage. So we compare the ACTUAL prod schema against
// a shadow DB with all local migrations applied: any divergence = real drift.
//
// `supabase db diff --linked` does precisely that (shadow = migrations applied fresh;
// source = linked prod). Empty diff -> in sync. Non-empty -> prod !== migrations.
//
// Scope: `public` only by default. The auth schema is Supabase-managed (diffing it is
// noisy) and provisioning is moving out of the auth.users trigger into public RPCs
// (fivem-studio-017), so public is where the migration bodies that matter actually land.
// Override with: npm run db:drift-check -- --schema public,storage
//
// Requirements (local): supabase CLI logged in + linked, Docker running (shadow DB),
// and the prod DB password — set SUPABASE_DB_PASSWORD to run non-interactively, or let
// the CLI prompt you. Zero new CI secrets by design (fivem-studio-d6g chose local-first).
//
// Exit codes: 0 = in sync · 1 = drift detected · 2 = could not run the check.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}

// --- preflight -------------------------------------------------------------
const refFile = join(repoRoot, "supabase", ".temp", "project-ref");
if (!existsSync(refFile)) {
  fail(
    2,
    "✗ Supabase project not linked (supabase/.temp/project-ref missing).\n" +
      "  Run once:  supabase link --project-ref <prod-ref>",
  );
}
const ref = readFileSync(refFile, "utf8").trim();

const schemaArg = (() => {
  const i = process.argv.indexOf("--schema");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : "public";
})();

console.log(`▶ Diffing linked prod (${ref}) against local migrations — schema: ${schemaArg}`);
console.log("  (shadow DB applies every migration fresh, then compares to prod)\n");

// --- run the diff ----------------------------------------------------------
// stdout is piped so we can inspect the generated diff; stderr/stdin are inherited
// so the CLI's progress + interactive password prompt still reach the terminal.
const res = spawnSync("supabase", ["db", "diff", "--linked", "--schema", schemaArg], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["inherit", "pipe", "inherit"],
  shell: isWin, // resolve supabase.cmd on Windows; foreground TTY, no popup
});

if (res.error) {
  fail(
    2,
    `✗ Could not launch the supabase CLI: ${res.error.message}\n  Is it installed and on PATH?`,
  );
}
if (res.status !== 0) {
  fail(
    2,
    `✗ supabase db diff exited ${res.status}. Common causes:\n` +
      "  • Docker not running (the shadow DB needs it)\n" +
      "  • wrong/missing DB password (set SUPABASE_DB_PASSWORD)\n" +
      "  • not logged in (supabase login)",
  );
}

// A diff is "empty" if, after stripping SQL comments + whitespace, nothing remains.
const raw = res.stdout ?? "";
const meaningful = raw
  .split("\n")
  .filter((l) => !l.trim().startsWith("--") && l.trim() !== "")
  .join("\n")
  .trim();

if (meaningful === "") {
  console.log("✓ In sync — prod schema matches local migrations. No drift.");
  process.exit(0);
}

console.error("\n✗ DRIFT DETECTED — prod schema diverges from local migrations.");
console.error("  The statements below would have to run on prod to match the migrations,");
console.error("  which means a recorded-as-applied migration did not fully execute:\n");
console.error(raw.trimEnd());
console.error(
  "\n  Investigate with:  supabase migration list --linked" +
    "\n  (history may still show the offending migration as 'applied').",
);
process.exit(1);
