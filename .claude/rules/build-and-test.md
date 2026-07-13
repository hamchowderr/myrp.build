# Build & test

Electron + electron-vite — **three targets** (main, preload, renderer). "Done" for a feature = **Tier 0 + Tier 1 green** (both free; agent tests are AIMock-mocked, no API credits).

## Commands
- `npm run typecheck` — tsc for BOTH `tsconfig.node.json` (main + preload) and `tsconfig.web.json` (renderer). Both must pass.
- `npm run check` — Biome lint + format (`check:fix` to autofix). Warnings are non-blocking; errors fail.
- `npm run fallow` — dead-code / dupes / health scan. **Non-blocking** in CI (informational).
- `npm run test` — Vitest: unit + Mastra agent tests via AIMock (no credits).
- `npm run dev` — Electron + Vite HMR.
- `npm run build` / `npm run build:win` — compile-check build / signed Windows installer. `build:unpack:nosign` = fast unpacked exe.

## Maintenance checks
- `npm run db:drift-check` — diff the **linked cloud Supabase** against local `supabase/migrations/`; a non-empty diff means a migration is recorded-as-applied but its body didn't fully run. Needs the CLI linked + Docker (shadow DB). Local-first, zero CI secrets.
- `npm run ox:currency` — check the `ox_*` versions pinned in `docs/ox-server-setup.md` against the latest Overextended releases (via `gh`). CI-ready; exits non-zero when a pinned version is behind. Run it after touching ox versions instead of checking by hand.

## Conventions
- **500-line hard cap** per file; review anything over ~300 lines for splitting.
- Two type-declaration files MUST stay in sync: `src/preload/index.d.ts` and `src/renderer/src/env.d.ts` (both declare `window.api`).
- shadcn/ui components live in `src/renderer/src/components/ui/`; fix imports to `@renderer/lib/utils` after adding one.
- Run `npm run typecheck` before calling any task done.
- CI (`.github/workflows/ci.yml`) gates merges on Tier 0 + Tier 1.
