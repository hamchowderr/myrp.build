#!/usr/bin/env node
/**
 * Cut a signed Windows release and publish it as a GitHub DRAFT.
 *
 * Why this exists: every link in signing -> installer -> publish -> auto-update
 * was configured but only the installer had ever been run. `gh release list` was
 * empty, so `electron-updater` had never had anything to check against. A chain
 * you have never pulled is not a chain.
 *
 *   npm run release:check   # preflight only — no build, no upload
 *   npm run release:win     # preflight, then build + sign + publish a draft
 *
 * Deliberately LOCAL, not CI. Signing needs the TrustedSigning PowerShell module
 * plus three Azure credentials that live in Infisical; copying those into GitHub
 * Actions secrets on a PUBLIC repo is a decision to make on purpose, not one to
 * back into the week of a launch. Everything needed is already on this machine.
 *
 * The release is a DRAFT (electron-builder.yml `releaseType: draft`) — nothing is
 * visible to users until someone publishes it in the GitHub UI. That is the
 * intended safety valve: build, install it yourself, then publish.
 *
 * Secrets are read from the environment and NEVER printed. Preflight reports
 * presence and length only.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CHECK_ONLY = process.argv.includes("--check");
const INFISICAL_PROJECT = "e56e0da5-6460-4bab-bdd6-2fd12ac5447b";

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => console.log(`  ✗ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);

const failures = [];
const warnings = [];
function require_(cond, okMsg, failMsg) {
  if (cond) ok(okMsg);
  else {
    bad(failMsg);
    failures.push(failMsg);
  }
}
function prefer(cond, okMsg, warnMsg) {
  if (cond) ok(okMsg);
  else {
    warn(warnMsg);
    warnings.push(warnMsg);
  }
}

/** Run a command for its stdout; returns null instead of throwing. */
function tryExec(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...opts,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

console.log(`\nrelease preflight — myRP.build v${pkg.version}\n`);

// ---------------------------------------------------------------------------
// 1. Repository state. A release must be reproducible from a commit that exists
//    on the remote, or the tag points at something nobody else can check out.
// ---------------------------------------------------------------------------
console.log("1. repository");
const branch = tryExec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
const status = tryExec("git", ["status", "--porcelain"]);
require_(branch === "main", `on main`, `on '${branch}' — release from main`);
require_(!status, "working tree clean", "working tree dirty — commit or stash first");

tryExec("git", ["fetch", "--quiet", "origin", "main"]);
const ahead = tryExec("git", ["rev-list", "--count", "origin/main..HEAD"]);
const behind = tryExec("git", ["rev-list", "--count", "HEAD..origin/main"]);
require_(ahead === "0", "no unpushed commits", `${ahead} commit(s) not pushed — push first`);
require_(
  behind === "0",
  "up to date with origin",
  `${behind} commit(s) behind origin/main — pull first`,
);

// A version that already shipped would overwrite an existing release's assets.
const tags = tryExec("gh", ["release", "list", "--limit", "100"]) ?? "";
const already = tags.split("\n").some((l) => l.includes(`v${pkg.version}`));
require_(
  !already,
  `version ${pkg.version} not yet released`,
  `a release for v${pkg.version} already exists — bump the version first`,
);

// ---------------------------------------------------------------------------
// 2. Code signing. Without the module electron-builder produces an UNSIGNED
//    installer, which SmartScreen will block for every user who downloads it.
// ---------------------------------------------------------------------------
console.log("\n2. code signing");
if (process.platform === "win32") {
  // Resolve the shell the SAME way app-builder-lib does (vm.js): prefer pwsh.exe,
  // fall back to powershell.exe. This is not pedantry — the two have separate
  // module paths (Documents\PowerShell vs Documents\WindowsPowerShell), so asking
  // the wrong one reports the module missing when signing would have worked fine.
  const shell = tryExec("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-Command pwsh.exe",
  ])
    ? "pwsh.exe"
    : "powershell.exe";
  const mod = tryExec(shell, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "(Get-Module -ListAvailable -Name TrustedSigning | Select-Object -First 1).Version.ToString()",
  ]);
  // A WARNING, not a blocker: electron-builder installs the module itself
  // (`Install-Module -Name TrustedSigning ... -Scope CurrentUser`) when it is
  // absent. Present just means the build won't pause to fetch it.
  prefer(
    Boolean(mod),
    `TrustedSigning ${mod} visible to ${shell}`,
    `TrustedSigning not visible to ${shell} — electron-builder will install it on first run`,
  );
} else {
  warn(`not Windows (${process.platform}) — signing check skipped`);
}

// ---------------------------------------------------------------------------
// 3. Credentials. Reported by NAME and LENGTH only — never by value.
//    Azure: electron-builder's EnvironmentCredential reads these to sign.
//    GH_TOKEN: electron-builder uploads the release assets with it.
// ---------------------------------------------------------------------------
console.log("\n3. credentials");
const AZURE = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
const probe = tryExec(
  "infisical",
  [
    "run",
    `--projectId=${INFISICAL_PROJECT}`,
    "--env=prod",
    "--path=/myrp-build",
    "--recursive",
    "--silent",
    "--",
    "node",
    "-e",
    `console.log(${JSON.stringify(AZURE)}.map(n=>n+'='+((process.env[n]||'').length)).join(','))`,
  ],
  { env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
);

if (probe) {
  for (const pair of probe.split(",")) {
    const [name, len] = pair.split("=");
    require_(Number(len) > 0, `${name} present (${len} chars)`, `${name} missing from Infisical`);
  }
} else {
  bad("could not reach Infisical — is `infisical` logged in?");
  failures.push("infisical unreachable");
}

const ghToken = tryExec("gh", ["auth", "token"]);
require_(
  Boolean(ghToken),
  `GH_TOKEN available from gh (${ghToken?.length} chars)`,
  "no GitHub token — run `gh auth login`",
);

// ---------------------------------------------------------------------------
// 4. Bundled resources. These are copied into the installer by extraResources;
//    missing, the app silently loses its embedder or its Lua language server.
// ---------------------------------------------------------------------------
console.log("\n4. bundled resources");
for (const rel of ["build/fastembed-models", "build/lua-language-server"]) {
  prefer(
    existsSync(join(ROOT, rel)),
    `${rel} present`,
    `${rel} missing — the installer will ship without it`,
  );
}

// ---------------------------------------------------------------------------
console.log("");
if (failures.length) {
  console.log(`preflight FAILED — ${failures.length} blocker(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
if (warnings.length) console.log(`preflight passed with ${warnings.length} warning(s).`);
else console.log("preflight passed.");

if (CHECK_ONLY) {
  console.log("\n--check: stopping before the build.\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Build + sign + upload. `--publish always` is what makes electron-builder push
// the installer AND latest.yml; without latest.yml the auto-updater has nothing
// to read, which is exactly the state this whole script exists to fix.
// ---------------------------------------------------------------------------
console.log(`\nbuilding + signing + publishing draft v${pkg.version} …\n`);
const res = spawnSync(
  "infisical",
  [
    "run",
    `--projectId=${INFISICAL_PROJECT}`,
    "--env=prod",
    "--path=/myrp-build",
    "--recursive",
    "--silent",
    "--",
    "npx",
    "electron-builder",
    "--win",
    "--publish",
    "always",
  ],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, MSYS_NO_PATHCONV: "1", GH_TOKEN: ghToken ?? "" },
  },
);

if (res.status !== 0) {
  console.log("\nrelease FAILED — see the electron-builder output above.\n");
  process.exit(res.status ?? 1);
}

console.log(`
release v${pkg.version} uploaded as a DRAFT.

Next, in order — each step tests a link that has never been pulled:
  1. gh release view v${pkg.version}   — confirm the installer AND latest.yml are attached
  2. install the .exe on a clean machine and launch it
  3. bump the version, run this again, and confirm the installed copy self-updates
  4. only then publish the draft in the GitHub UI
`);
