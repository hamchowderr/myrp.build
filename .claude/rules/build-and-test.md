# Build & test

Electron + electron-vite — **three targets** (main, preload, renderer). "Done" for a feature = **Tier 0 + Tier 1 green** (both free; agent tests are AIMock-mocked, no API credits).

## Commands
- `npm run typecheck` — tsc for BOTH `tsconfig.node.json` (main + preload) and `tsconfig.web.json` (renderer). Both must pass.
- `npm run check` — Biome lint + format (`check:fix` to autofix). Warnings are non-blocking; errors fail.
- `npm run fallow` — dead-code / dupes / health scan. **Non-blocking** in CI (informational).
- `npm run test` — Vitest: unit + Mastra agent tests via AIMock (no credits).
- `npm run dev` — Electron + Vite HMR.
- `npm run build` / `npm run build:win` — compile-check build / signed Windows installer. `build:unpack:nosign` = fast unpacked exe.

## Patched dependency — `@mastra/core` (read before bumping it)

`patches/@mastra+core+1.53.0.patch` ports **mastra-ai/mastra PR #19940** (fix for issue
**#19814**) onto the published bundle. `postinstall` runs `patch-package --error-on-fail`, so a
patch that stops applying **fails the install loudly** instead of silently reintroducing the bug.

Without it the supervisor loop is unusable: `#validateSuspendedToolCallTarget` polls for the
snapshot holding the target suspension and then discards it, so `resumeStream` rehydrates
`MessageList` from the **stale** snapshot and loses the second auto-approved tool result. The agent
then can't see its own work and rewrites the same file until the step budget trips (measured live:
49 identical writes, 1.29M tokens, no `fxmanifest.lua`). Upstream's own trigger is a non-yolo
`AgentController` plus a tool whose effective policy is `allow` — which is every `edit`-category
tool we have.

Because we consume the built package, the patch edits **both** bundles (`dist/chunk-3S5BFAEP.js`
ESM and `dist/chunk-ODHD3TLJ.cjs` CJS), six sites each. Source maps go stale (cosmetic).

**Bumping `@mastra/core` (incl. via `npm update`, which currently wants 1.55.0):**
1. Check whether #19940 merged and shipped. If yes → delete the patch file and the
   `patch-package` step, then confirm `tests/mastra/loop-context.test.ts` still passes.
2. If not → re-port the six edits and re-run `npx patch-package @mastra/core`. **1.55.0 does not
   contain the fix** (verified by upgrading all five `@mastra/*` and re-running the repro).
3. Either way the gate is `tests/mastra/loop-context.test.ts` — "carries each step's tool result
   into the next request" fails if the patch is missing.

Do **not** work around a failing patch by disabling `--error-on-fail`. Yolo mode is also not an
escape: it fixes the loop but voids ALL approval gating, including live-server deploys and host
shell execution — measured in `tests/mastra/yolo-approval.test.ts`, which pins that behaviour.

## Maintenance checks
- `npm run deps:check` — dependency drift + advisory gate. Fails on **in-range drift** (a dep behind
  what our own `^` range already allows — close it with `npm update`) or on any advisory not in the
  allowlist. Newer majors are reported but never fail. Advisories are split by whether they actually
  ship: the **production** tree (`--omit=dev`) is what users get; electron-builder / `mastra` CLI
  findings are build-time only. **Never trust `npm audit fix --force` here** — on this repo npm has
  proposed major *downgrades* as "fixes" (electron-builder 26→22, mastra 1.20→0.18,
  @mastra/fastembed 1.2→1.0, all three already at latest). Park anything unfixable in `ALLOW` in
  `scripts/deps-check.mjs` **with a reason**; entries that stop matching are reported as stale.
- `npm run db:drift-check` — diff the **linked cloud Supabase** against local `supabase/migrations/`; a non-empty diff means a migration is recorded-as-applied but its body didn't fully run. Needs the CLI linked + Docker (shadow DB). Local-first, zero CI secrets.
- `npm run ox:currency` — check the `ox_*` versions pinned in `docs/ox-server-setup.md` against the latest Overextended releases (via `gh`). CI-ready; exits non-zero when a pinned version is behind. Run it after touching ox versions instead of checking by hand.

## Releasing (`scripts/release.mjs`)
> **Full runbook: `docs/releasing.md`** — the four links (sign → build → publish → update),
> the MANDATORY post-publish check (the first release ever cut produced TWO drafts with the
> assets split, and the build log said success), and how the updater actually resolves
> `latest.yml`. Read it before cutting or debugging a release.

- `npm run release:check` — preflight only, no build. Verifies: on `main`, clean tree, synced
  with origin, version not already released, the `TrustedSigning` module, the three Azure
  credentials + a GitHub token (**by length only — never printed**), and the bundled
  `build/fastembed-models` + `build/lua-language-server`.
- `npm run release:win` — clean → `build:prod` → preflight → `electron-builder --win --publish always`.
  `--publish always` is what uploads **`latest.yml` alongside the installer**; without it the
  auto-updater has nothing to read.
- **Local, not CI, on purpose.** Signing needs the `TrustedSigning` PowerShell module plus
  `AZURE_TENANT_ID`/`CLIENT_ID`/`CLIENT_SECRET`, which live in Infisical (`prod`, `/myrp-build`,
  `--recursive`). Copying those into Actions secrets on a **public** repo is a deliberate call, not
  a launch-week reflex.
- electron-builder resolves **`pwsh.exe` first**, falling back to `powershell.exe` (`app-builder-lib/out/vm/vm.js`).
  The two have separate module paths (`Documents\PowerShell` vs `Documents\WindowsPowerShell`), so a
  module check against the wrong shell reports "missing" when signing works fine. It also
  self-installs the module when absent — so that check is a warning, never a blocker.
- Releases publish as a **draft** (`releaseType: draft`), invisible until published in the GitHub UI.
  Order that matters: verify the assets → install clean → cut a `+1` version and confirm the
  installed copy **self-updates** → only then publish. Steps 3 is the one nobody tests until it fails.

## Conventions
- **500-line hard cap** per file; review anything over ~300 lines for splitting.
- Two type-declaration files MUST stay in sync: `src/preload/index.d.ts` and `src/renderer/src/env.d.ts` (both declare `window.api`).
- shadcn/ui components live in `src/renderer/src/components/ui/`; fix imports to `@renderer/lib/utils` after adding one.
- Run `npm run typecheck` before calling any task done.
- CI (`.github/workflows/ci.yml`) gates merges on Tier 0 + Tier 1.
