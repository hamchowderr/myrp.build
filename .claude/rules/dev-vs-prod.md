# Dev vs Prod — how the app runs, and how to actually see your change

myRP.build runs in two **completely separate** modes, decided at BUILD time by the `__DEV_BYPASS__` literal in `electron.vite.config.ts` (`mode === "development" && FIVEM_STUDIO_DEV === "1"`). Packaged builds always compile it to `false`.

**`npm run dev` is the owner dev-bypass experience — NOT what an installed user gets.** Two modes (dev-bypass vs prod), three ways to actually run it:

| Run it with… | Mode | Sign-in + billing | Inference | Data backend | Source edits show up? |
|---|---|---|---|---|---|
| `npm run dev` **+ `FIVEM_STUDIO_DEV=1`** | **Dev-bypass** (owner) | none | Vercel AI Gateway (`VERCEL_GATEWAY_KEY`) | **local** Supabase (`127.0.0.1:55321`) | renderer: HMR · main/preload: **restart `dev`** |
| `npm run dev` (no flag) / `npm run dev:prod` | **Prod path, from source** | Discord OAuth + Stripe | proxy → AI Gateway | local (`dev`) / hosted (`dev:prod`) | renderer: HMR · main/preload: restart |
| packaged `.exe` — `build:win` / `build:unpack:nosign` / installed | **Prod — what users get** | Discord OAuth + Stripe | proxy → AI Gateway | **cloud** Supabase (`tpqoaxmjkgmtqvntrlzp`) | **NO — frozen; REBUILD required** |

## The two modes
- **Dev (owner)** — `npm run dev` with `FIVEM_STUDIO_DEV=1` in `.env`. `App.tsx` renders `AppContent` + `DevAccountProvider`: no sign-in, no billing, generation uses the **Vercel AI Gateway** (`VERCEL_GATEWAY_KEY`, free monthly credits) — the bare `ANTHROPIC_API_KEY` fallback was removed. Supabase/auth are never imported.
- **Prod (users)** — packaged build. `App.tsx` lazy-loads `AuthApp`: Discord sign-in (native Supabase OAuth, PKCE) + Stripe billing + the inference proxy.

## Local vs cloud data (Supabase)
Which database backs agent memory + RAG depends on the mode:
- **Prod** (packaged): memory + RAG read/write the **cloud** Supabase project (`tpqoaxmjkgmtqvntrlzp`) from the main process via supabase-js (anon key + per-run JWT; RLS reads, SECURITY DEFINER writes). **No DB credential is shipped.** See `supabase-billing.md`.
- **Dev** (`FIVEM_STUDIO_DEV=1`): uses the **same** `SupabaseMemoryStorage` adapter against **local** Supabase (`127.0.0.1:55321`) — `storage/dev-auth.ts` signs in the seeded dev user (`supabase/seed.sql`) for a JWT. Same path/schema as prod; the old raw-`PostgresStore` fallback is gone. If dev chat memory errors, run `supabase db reset` (rebuilds schema + re-seeds the dev user). Requires local Supabase running (`supabase start`).
- **Both modes:** workflow approval snapshots are **always local** (`InMemoryStore`), never cloud.

### Local RAG corpus (ic8)
The ox knowledge corpus (`ox_corpus`) is empty in a fresh local DB, so `match_ox_corpus` returns `[]` and `rag.ts` no-ops. To get real RAG locally/self-host, seed it AFTER `supabase db reset`:
```bash
npm run db:seed-corpus   # loads supabase/ox_corpus.jsonl.gz into ox_corpus (~15.7k rows, seconds)
```
The shipped snapshot (`supabase/ox_corpus.jsonl.gz`, ~22 MB) holds the corpus WITH precomputed fastembed embeddings (bge-small 384-dim, 6-dp rounded — the same model `rag.ts` queries with), so the seed is a plain load (~40s), no embedding step. `seed.sql` can't do it (pure SQL, gzipped file) — it stays a separate `db:seed-corpus` step.

## Seeing your change — match the surface to the run mode
- **Renderer edits** (screens, components, CSS): `npm run dev` hot-reloads them; if not, `Ctrl+R` in the window.
- **Main / preload edits** (IPC, windows, auto-deploy, fileWriter, Mastra): NOT hot-reloaded — fully restart `npm run dev`.
- **Auth / billing screens** (`CustomAuth`, `SubscriptionSection`): these render only on the PROD path, so dev-bypass hides them. To see them in dev with HMR: run `npm run dev` **without** `FIVEM_STUDIO_DEV=1` (→ `AuthApp` against local Supabase), or `npm run dev:prod` (against hosted).
- **Packaged builds are FROZEN.** A `dist/win-unpacked/*.exe` or an installed app ships its own bundled copy and never reads your working tree — source changes require a REBUILD (`build:unpack:nosign` / `build:win`). If "my change isn't showing," first confirm you aren't looking at a stale packaged build (check the build-provenance stamp in Settings → About).

## Don't
- Don't debug a packaged build expecting source edits to appear — rebuild first.
- Don't assume a control is "broken" when it may be disabled (missing state) or failing silently — check the console / the surfaced error before concluding.
