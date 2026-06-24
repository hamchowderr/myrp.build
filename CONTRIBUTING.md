# Contributing to myRP.build

Thanks for your interest in building myRP.build. This guide covers local setup, how the app runs, project conventions, and how changes land.

> **Heads up — source-available, not classic open source.** The client is licensed under the **Functional Source License (FSL-1.1-Apache-2.0)**: use, self-host, modify, and fork freely; you just can't run a competing hosted service from it (each release auto-converts to Apache-2.0 after two years). See the [README License section](README.md#license). **Public contributions require signing the CLA** (so the project stays relicensable) — a bot will prompt you on your first PR.

---

## 1. Prerequisites

- **Windows 10/11** (the app uses Win32 FFI for the FXDK integration; Linux support is on the roadmap)
- **Node.js 20+**
- A **FiveM server** running locally — or a path to one's `resources/` folder
- An API key for at least one supported provider (default config expects `ANTHROPIC_API_KEY`)

## 2. Setup

```bash
git clone https://github.com/hamchowderr/myrp.build.git
cd myrp.build
npm install
cp .env.example .env       # then fill in your keys
npm run dev                # Electron + Vite HMR
```

The first-launch wizard points the app at your FiveM server and `resources/[local]/`.

## 3. How the app runs — dev vs. the real app

This trips people up, so read it before "my change isn't showing." myRP.build runs in **two completely separate modes**, decided at build time by `FIVEM_STUDIO_DEV`:

| Run it with… | Mode | Sign-in + billing | Inference | Source edits show up? |
|---|---|---|---|---|
| `npm run dev` **+ `FIVEM_STUDIO_DEV=1`** | **Dev-bypass** (your local dev) | none | direct API key | renderer: HMR · main/preload: **restart `dev`** |
| `npm run dev` (no flag) / `npm run dev:prod` | **Prod path, from source** | Discord + Stripe | proxy → AI Gateway | renderer: HMR · main/preload: restart |
| packaged `.exe` (`build:win` / installed) | **Prod — what users get** | Discord + Stripe | proxy → AI Gateway | **NO — frozen; rebuild required** |

- **Renderer edits** (screens, components, CSS) hot-reload. **Main / preload edits** (IPC, windows, Mastra, fileWriter) are **not** hot-reloaded — fully restart `npm run dev`.
- **Packaged builds are frozen** — a `dist/` exe ships its own bundled copy and never reads your working tree. Source changes require a rebuild.

## 4. Project layout

See the [Architecture section](README.md#architecture) of the README for the full tree. The areas you'll touch most:

- `src/main/mastra/` — the generation agent, workspace, prompt, and skills wiring
- `src/main/ipc/` — IPC handlers bridging renderer ↔ main
- `src/renderer/src/` — the React 19 UI (screens, chat, builder)
- `skills/` — the ox knowledge packages the agent loads on demand
- `supabase/` — cloud Postgres migrations + Deno edge functions

## 5. Conventions

- **ox_overextended only.** Generated code and skills target the ox ecosystem (`ox_core`, `ox_lib`, `ox_inventory`, `ox_target`, `oxmysql`) — no other FiveM frameworks or DB drivers. Don't reintroduce them.
- **500-line hard cap per file.** Review anything over ~300 lines for splitting.
- **Keep the two type-declaration files in sync:** `src/preload/index.d.ts` and `src/renderer/src/env.d.ts` (both declare `window.api`).
- **shadcn/ui** components live in `src/renderer/src/components/ui/`; fix imports to `@renderer/lib/utils` after adding one.
- **Formatting & lint:** [Biome](https://biomejs.dev/) — `npm run check` (or `check:fix` to autofix). Errors fail; warnings don't.
- **Adding a skill:** create its folder under `skills/` (with a `SKILL.md` whose `name:` matches the folder) **and** add its name to the `OX_SKILLS` allowlist in `src/main/mastra/workspace.ts`.

## 6. Issues & where work is tracked

We track work in **[beads](https://github.com/gastownhall/beads)** (`bd`) — the backlog lives in `.beads/` right in the repo, so after cloning you can see what's open with `bd ready` / `bd list` (install bd, then `bd prime` for the workflow). Prefer not to install anything? File bugs and ideas as **GitHub Issues**, or start design conversations in **Discussions** — the maintainers triage those into beads.

As in §8, anything beyond a trivial fix should be tied to an issue we've already agreed on **before** you open a PR — check for an existing issue (or open one), get a 👍 on the approach, and comment on the one you're taking so two people don't build the same thing.

## 7. Tests & the quality gate

Generation logic is tested through **AIMock** (in-process, deterministic, **zero API credits**) — add or keep AIMock coverage rather than hitting the live API. The five tiers (Static → Unit/agent → Eval → E2E → Manual) are described in the [README](README.md#build--test).

**Before any PR, this must be green (CI enforces it):**

```bash
npm run typecheck && npm run check && npm test
```

## 8. Contributing code — read this before you open a PR

We welcome real contributions and review them carefully. To keep that sustainable, the bar is **deliberately strict**. Most rejected PRs aren't rejected because the idea was bad — they're rejected because they skipped the steps below.

### Talk first — no surprise PRs

For anything beyond a one-line fix (typo, obvious bug), **open or comment on an issue/[discussion](https://github.com/hamchowderr/myrp.build/discussions) first** and wait for a maintainer 👍 on the approach. A green light on *what* and *how* before you write code saves everyone a wasted PR.

- **No linked, maintainer-approved issue → no PR.** Unsolicited large or wide-reaching PRs — and **any AI-generated PR without a linked issue — are auto-closed. No exceptions, no line-by-line review**, regardless of whether CI passes. Open the issue, get the 👍, *then* write the code.
- Claim the issue you're working so two people don't build the same thing.

### You own every line

Using an AI assistant to help write code is fine — we do too. But:

- **You must understand, run, and stand behind every line you submit.** You are the author; the model is not. "I ran it through an AI" is **not** a substitute for review.
- PRs that are visibly unreviewed model output — hallucinated or non-existent APIs, code that doesn't compile or run, invented `ox_*` exports, generic boilerplate that ignores the surrounding code — are **closed on sight**. Re-open one once you've actually done the work.
- Match the **existing code's** style, naming, and structure. A PR that reformats or "modernizes" code to a different taste is churn, not a contribution.

### The bar — what gets merged, what gets closed

| ✅ We merge | ❌ We close |
|---|---|
| One focused concern per PR, tied to an agreed issue | Mixed bags (a fix + a refactor + a dep bump in one PR) |
| Behavior changes that come **with AIMock tests** (§7) | New behavior or "fixes" with no test and no repro |
| Code that respects the conventions in §5 | Anything that breaks **ox-only**, the **500-line cap**, or the two type-decl files |
| Green `typecheck && check && test` **before** you open | Red CI, or "it works on my machine" |
| Small, reviewable diffs | Formatting-only / comment-rewording / rename-for-taste / unexplained dependency-bump PRs |
| A clear description of *why*, not just *what* | "I let a tool run over the repo" sweeps |

**Maintainer discretion is final.** A passing CI does not entitle a merge — scope, fit, and product direction are the maintainer's call. If your change doesn't fit the roadmap, we'll say so early (which is exactly why we ask you to *talk first*).

### The mechanics

1. **Branch** off `main` — `feature/…`, `fix/…`, or `chore/…`. Never push to `main` directly.
2. Make the change; **keep commits focused** with clear messages (Conventional Commits style appreciated: `fix(backup): …`).
3. **Run the quality gate** (§7) — green Tier 0 + Tier 1 — *before* you open the PR.
4. Open the PR; fill in the template honestly. CI runs the same gate. **Sign the CLA** when the bot prompts you (one-time; see the note at the top of this file) — we can't merge without it.
5. We squash-merge and delete the branch.

## 9. Reporting bugs & ideas

[Open a discussion](https://github.com/hamchowderr/myrp.build/discussions) with what you expected, what happened, your OS/Node versions, and repro steps. For generation bugs, include the prompt and the generated output (or the console error).

---

Thanks for helping make myRP.build better. 🏗️
