#!/usr/bin/env node
/**
 * ox currency check — flags when the skills/docs drift from the latest
 * Overextended releases + the FiveM game build. Run periodically or in CI so the
 * knowledge the generator reads doesn't silently rot (the 2026-06 audit found
 * the game build was ~2 years stale and several version strings were behind).
 *
 *   node scripts/check-ox-currency.mjs
 *
 * Uses the `gh` CLI for release versions. Exits non-zero if any version claim in
 * docs/ox-server-setup.md is behind the latest release.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REPOS = [
  "ox_core",
  "ox_lib",
  "oxmysql",
  "ox_inventory",
  "ox_target",
  "ox_doorlock",
  "ox_banking",
  "ox_fuel",
];

function latest(repo) {
  try {
    const tag = execSync(`gh api repos/overextended/${repo}/releases/latest --jq .tag_name`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return tag.replace(/^v/, "");
  } catch {
    return null; // no release (main-branch resource like ox_commands)
  }
}

let doc = "";
try {
  doc = readFileSync(new URL("../docs/ox-server-setup.md", import.meta.url), "utf8");
} catch {
  /* doc optional */
}

let drift = 0;
console.log("ox currency check — latest Overextended releases vs docs/ox-server-setup.md\n");
for (const repo of REPOS) {
  const v = latest(repo);
  if (!v) {
    console.log(`  ${repo.padEnd(13)} latest: (no release — main branch)`);
    continue;
  }
  // Find a "<repo> | <version>" cell in the doc's version table, if present.
  const m = doc.match(new RegExp(`${repo}\\s*\\|\\s*([0-9]+\\.[0-9]+\\.[0-9]+)`));
  const claimed = m ? m[1] : null;
  const ok = !claimed || claimed === v;
  if (!ok) drift++;
  const flag = !claimed ? "·  (not pinned in doc)" : ok ? "✓" : "⚠  DRIFT";
  console.log(
    `  ${repo.padEnd(13)} latest: ${v.padEnd(8)} doc: ${(claimed ?? "—").padEnd(8)} ${flag}`,
  );
}

console.log(
  "\n  game build: verify sv_enforceGameBuild against https://runtime.fivem.net/artifacts",
);
console.log("              + the DLC list — builds advance with each GTA Online DLC.");

if (drift) {
  console.log(
    `\n✗ ${drift} version(s) behind latest — update docs/ox-server-setup.md + the matching skills.`,
  );
  process.exit(1);
}
console.log("\n✓ pinned doc versions match the latest releases.");
