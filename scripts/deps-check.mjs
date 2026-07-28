#!/usr/bin/env node
/**
 * Dependency drift + advisory gate.
 *
 *   npm run deps:check
 *
 * Three questions, one command:
 *
 *   1. IN-RANGE DRIFT — installed vs the newest version our own semver range
 *      already allows. This is free to close (`npm update`) and nobody chose it,
 *      so it always fails the check. This is the "no drift" gate.
 *   2. MAJOR BEHIND — a newer major exists outside our range. Informational
 *      only: taking it is a deliberate migration, not drift.
 *   3. ADVISORIES — `npm audit`, split by whether the finding actually ships.
 *      Production findings (the packaged app) are gated hard; build-time-only
 *      findings are gated against the allowlist below.
 *
 * The allowlist is the point. `npm audit` will happily propose a MAJOR DOWNGRADE
 * as a "fix" (it has suggested electron-builder 26 -> 22, mastra 1.20 -> 0.18 and
 * @mastra/fastembed 1.2 -> 1.0 on this repo — all three were already at latest).
 * Anything parked here needs a reason and stays visible in the output, so the
 * residue can't silently grow. Entries that stop matching are reported as stale
 * so they get pruned.
 */
import { execSync } from "node:child_process";

const NODE_MAJOR = 24; // see bd memory myrp-build-requires-node-24 (npm 11 lockfile shape)

/**
 * Advisories we knowingly carry, because every available "fix" is worse than the
 * finding. Keep `reason` concrete enough that the next person can re-test it.
 */
const ALLOW = [
  {
    cluster: "electron-builder build chain — minimatch/glob DoS",
    scope: "build",
    packages: [
      "@electron/asar",
      "@electron/universal",
      "app-builder-lib",
      "dir-compare",
      "dmg-builder",
      "ejs",
      "electron-builder",
      "electron-builder-squirrel-windows",
      "electron-winstaller",
      "filelist",
      "glob",
      "jake",
      "rimraf",
      "temp",
    ],
    reason:
      "All of these are flagged only for depending on minimatch <=10.0.2 / glob <=10.5.0. " +
      "The sole patched releases are minimatch 10.2.6 and glob 11+, whose CJS entry points export a " +
      "namespace rather than a callable. dir-compare (via @electron/universal) calls minimatch as a " +
      "function and rimraf@2 (via temp -> electron-winstaller) uses glob's callback API, so an override " +
      "breaks the Windows installer build. Build-time only — never bundled into the app. " +
      "Recheck when electron-builder ships modernised transitive deps.",
  },
  {
    cluster: "mastra CLI dev server",
    scope: "build",
    packages: [
      "@hono/node-ws",
      "@mastra/deployer",
      "brace-expansion",
      "mastra",
      "minimatch",
      "serve",
      "serve-handler",
    ],
    reason:
      "The `mastra` CLI (npm run studio) only. serve-handler is vulnerable at every published version " +
      "(no fix exists) and npm's suggested fix is a major downgrade to mastra@0.18.9. Local dev server " +
      "bound to localhost; not part of any shipped artifact.",
  },
  {
    cluster: "@mastra/core AI SDK compat aliases",
    scope: "runtime",
    packages: ["@ai-sdk/provider-utils", "@ai-sdk/ui-utils", "@mastra/core"],
    reason:
      "@mastra/core pins npm:-aliased legacy AI SDK builds (@ai-sdk/provider-utils-v5 -> 3.0.30, " +
      "@ai-sdk/ui-utils-v5 -> 1.2.11 -> provider-utils 2.2.8). The 2.x and 3.x lines have no patched " +
      "release — the fix only exists in 4.x/5.x — so an override would swap the alias for a different " +
      "major and break the shim. Low severity (resource consumption). Upstream @mastra/core must move.",
  },
  {
    cluster: "MCP SDK hono transport",
    scope: "runtime",
    packages: ["@hono/node-server"],
    reason:
      "@mastra/core -> @modelcontextprotocol/sdk -> @hono/node-server 1.x. The fix is 2.0.5+, a major " +
      "the SDK does not accept. The advisory is path traversal in hono's serve-static; we use MCP as a " +
      "client and never serve static files over it, so the vulnerable path is unreachable.",
  },
];

const ALLOWED = new Map();
for (const entry of ALLOW) {
  for (const pkg of entry.packages) ALLOWED.set(pkg, entry);
}

/**
 * Compare two `x.y.z[-pre]` versions. Enough for registry versions and avoids a
 * dependency; a prerelease sorts below its release. Returns -1 / 0 / 1.
 *
 * Needed because "installed !== wanted" is NOT the same as "behind": npm resolves
 * `wanted` from the `latest` dist-tag, while `npm update` installs the highest
 * version matching our range. electron-builder currently tags latest=26.15.3 but
 * publishes up to 26.15.7 under a `v26` tag, so a correct tree reads as newer
 * than `wanted`. Only a real regression counts as drift.
 */
function cmpSemver(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split("-");
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (A.nums[i] ?? 0) - (B.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  if (A.pre && B.pre) return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0;
  return 0;
}

/** npm outdated/audit exit non-zero by design — read stdout off the error too. */
function npmJson(args) {
  try {
    const out = execSync(`npm ${args}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.trim() ? JSON.parse(out) : {};
  } catch (err) {
    const out = String(err.stdout ?? "");
    if (out.trim()) {
      try {
        return JSON.parse(out);
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

const SEV_RANK = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };
const bySeverity = (a, b) =>
  (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) || a.name.localeCompare(b.name);

function fixLabel(fix) {
  if (fix === true) return "npm audit fix";
  if (!fix || typeof fix !== "object") return "none available";
  return `${fix.name}@${fix.version}${fix.isSemVerMajor ? " (MAJOR — verify, npm suggests downgrades)" : ""}`;
}

console.log("dependency check — drift, majors, and advisories\n");

const running = Number(process.versions.node.split(".")[0]);
if (running !== NODE_MAJOR) {
  console.log(
    `⚠  running node ${process.versions.node}; this repo's lockfile is npm 11 / node ${NODE_MAJOR}-shaped.`,
  );
  console.log("   Results (especially the lockfile) may differ from CI.\n");
}

let failures = 0;

/* ---------------------------------------------------------------- 1 + 2 ---- */

const outdated = npmJson("outdated --json") ?? {};
const entries = Object.entries(outdated);
const inRange = entries.filter(
  ([, v]) => v.current && v.wanted && cmpSemver(v.current, v.wanted) < 0,
);
// Installed above the `latest` dist-tag — legitimate (npm update takes the highest
// in-range version), but worth surfacing: we're on a build the maintainer has not
// promoted to latest.
const aheadOfTag = entries.filter(
  ([, v]) => v.current && v.wanted && cmpSemver(v.current, v.wanted) > 0,
);
const majorBehind = entries.filter(
  ([, v]) => v.wanted && v.latest && cmpSemver(v.wanted, v.latest) < 0,
);

console.log("1. in-range drift (installed vs our own semver range)");
if (inRange.length === 0) {
  console.log("   ✓ none — every dependency is at the newest version its range allows.\n");
} else {
  failures++;
  for (const [name, v] of inRange.sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`   ⚠  ${name.padEnd(38)} ${v.current}  ->  ${v.wanted}`);
  }
  console.log(`\n   ✗ ${inRange.length} behind. Close with: npm update\n`);
}

if (aheadOfTag.length > 0) {
  console.log(
    "   Ahead of the registry's `latest` tag (fine — npm update takes the highest in-range):",
  );
  for (const [name, v] of aheadOfTag.sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`   ·  ${name.padEnd(38)} ${v.current}  (latest tag: ${v.wanted})`);
  }
  console.log();
}

console.log("2. newer major available (outside our range — informational)");
if (majorBehind.length === 0) {
  console.log("   ✓ none.\n");
} else {
  for (const [name, v] of majorBehind.sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`   ·  ${name.padEnd(38)} ${v.wanted}  ->  ${v.latest}`);
  }
  console.log("\n   Deliberate migrations, not drift — take them one at a time.\n");
}

/* -------------------------------------------------------------------- 3 ---- */

const audit = npmJson("audit --json");
const prodAudit = npmJson("audit --json --omit=dev");

if (!audit) {
  console.log("3. advisories\n   ✗ could not run npm audit (offline?).\n");
  failures++;
} else {
  const all = Object.values(audit.vulnerabilities ?? {});
  const shipped = new Set(Object.keys(prodAudit?.vulnerabilities ?? {}));

  const unexpected = all.filter((v) => !ALLOWED.has(v.name)).sort(bySeverity);
  const parked = all.filter((v) => ALLOWED.has(v.name)).sort(bySeverity);

  const counts = audit.metadata?.vulnerabilities ?? {};
  console.log(
    `3. advisories — ${counts.critical ?? 0} critical · ${counts.high ?? 0} high · ` +
      `${counts.moderate ?? 0} moderate · ${counts.low ?? 0} low`,
  );
  const prodCounts = prodAudit?.metadata?.vulnerabilities;
  if (prodCounts) {
    console.log(
      `   of which SHIPPED (production tree): ${prodCounts.critical ?? 0} critical · ` +
        `${prodCounts.high ?? 0} high · ${prodCounts.moderate ?? 0} moderate · ${prodCounts.low ?? 0} low`,
    );
  }
  console.log();

  if (unexpected.length === 0) {
    console.log("   ✓ nothing outside the allowlist.\n");
  } else {
    failures++;
    console.log("   NOT ALLOWLISTED — triage these:");
    for (const v of unexpected) {
      const where = shipped.has(v.name) ? "SHIPPED" : "build  ";
      console.log(
        `   ⚠  [${v.severity.padEnd(8)}] ${where} ${v.name.padEnd(34)} fix: ${fixLabel(v.fixAvailable)}`,
      );
    }
    console.log(
      `\n   ✗ ${unexpected.length} advisory package(s) unaccounted for. Fix them, or add them to\n` +
        "     ALLOW in scripts/deps-check.mjs with a reason.\n",
    );
  }

  if (parked.length > 0) {
    console.log("   Allowlisted residue (carried deliberately):");
    const seen = new Set();
    for (const v of parked) {
      const entry = ALLOWED.get(v.name);
      if (seen.has(entry.cluster)) continue;
      seen.add(entry.cluster);
      const members = parked.filter((p) => ALLOWED.get(p.name) === entry);
      const worst = members.reduce((a, b) => (bySeverity(a, b) <= 0 ? a : b));
      const ships = members.some((m) => shipped.has(m.name));
      console.log(
        `\n   · ${entry.cluster}  [${members.length} pkg · worst ${worst.severity} · ${ships ? "SHIPPED" : "build-time only"}]`,
      );
      for (const line of entry.reason.match(/.{1,88}(\s|$)/g) ?? []) {
        console.log(`     ${line.trim()}`);
      }
    }
    console.log();
  }

  // An allowlist entry that no longer matches anything is dead weight — say so.
  const live = new Set(all.map((v) => v.name));
  const stale = ALLOW.filter((e) => !e.packages.some((p) => live.has(p)));
  if (stale.length > 0) {
    console.log("   Stale allowlist entries (advisory cleared upstream — delete them):");
    for (const e of stale) console.log(`   ·  ${e.cluster}`);
    console.log();
  }
}

/* ----------------------------------------------------------------------- */

if (failures > 0) {
  console.log("✗ dependency check failed — see the ✗ sections above.");
  process.exit(1);
}
console.log("✓ no drift; every advisory is accounted for.");
