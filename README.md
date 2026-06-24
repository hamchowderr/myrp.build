<div align="center">

# 🏗️ myRP.build

### Describe the resource. Get a working one — written straight to your server.

**myRP.build is an AI resource builder for the [ox_overextended](https://overextended.dev/) stack.** Tell it what you want in plain English. It writes the Lua, SQL, NUI, and `fxmanifest.lua` into `resources/[local]/`, reloads the resource over RCON, and reads the console back to prove it loaded clean — no snippets to paste, no manifest to hand-wire.

[![License: FSL-1.1-Apache-2.0](https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue)](#-license)
[![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange)]()
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)](#-getting-started)
[![Built for ox_overextended](https://img.shields.io/badge/built%20for-ox__overextended-7c3aed)](https://overextended.dev/)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/4zUPdu5W3j)
[![Website](https://img.shields.io/badge/website-myrp.build-111)](https://myrp.build)

</div>

![myRP.build Screenshot](docs/screenshot.png)

> _Screenshot placeholder — to be added._

---

## ⚡ What it does

Type what you want:

> _"A vehicle spawner for Pillbox EMS — rank-gated vehicles, a 30-second cooldown, garaged cars persisted to the database."_

myRP.build writes the **whole resource**. Not a snippet — a complete `resource/` directory: client and server Lua, ox_lib commands, ox_inventory hooks where they belong, a SQL migration if it needs persistence, NUI for anything on-screen, and an `fxmanifest.lua` that lines up with the files on disk _exactly_. Then it RCONs `refresh` + `ensure <resource>` and watches the console, so you know it loaded **before** you alt-tab back into the game.

Then just keep talking:

> _"Add a 30-second cooldown."_ · _"Make it admin-only."_ · _"Now build a sister resource for stolen vehicles."_

Every turn lands new files on disk. **Undo** reverses the last write; **auto-backup** snapshots the previous version before each regenerate — so experimenting costs you nothing.

Under the hood it isn't autocomplete. It's a single **[Mastra](https://mastra.ai/)** agent with a shared workspace, running locally in an isolated Electron utility process (the UI never blocks), that loads ground-truth [ox_overextended](https://overextended.dev/) knowledge on demand from a Skills system plus a RAG index of the ox source — so it builds against the APIs that **actually exist**, not a hallucinated guess.

---

## 📦 What a generation looks like

One prompt → a complete, loadable resource on disk. Here's the shape of the **"vehicle spawner for Pillbox EMS"** example above — rank-gated through an ox_lib ACE, with a 30-second cooldown:

<details>
<summary><code>resources/[local]/pillbox_vehspawner/</code> — click to expand</summary>

**`fxmanifest.lua`**

```lua
fx_version 'cerulean'
game 'gta5'

name 'pillbox_vehspawner'
author 'myRP.build'
version '1.0.0'
description 'Rank-gated EMS vehicle spawner with cooldown'

shared_script '@ox_lib/init.lua'
client_script 'client.lua'
server_script 'server.lua'

dependencies {
    'ox_lib',
    'ox_core',
}
```

**`server.lua`**

```lua
local COOLDOWN = 30000 -- 30 seconds
local lastSpawn = {}

-- `restricted` ties this command to the `group.ems` ACE — rank-gating, for free.
-- Put a medic in that group in server.cfg:
--   add_principal identifier.license:<id> group.ems
lib.addCommand('emsvehicle', {
    help = 'Spawn an EMS vehicle',
    params = { { name = 'model', help = 'Vehicle model name', type = 'string' } },
    restricted = 'group.ems',
}, function(source, args)
    local now = GetGameTimer()
    if lastSpawn[source] and now - lastSpawn[source] < COOLDOWN then
        return TriggerClientEvent('ox_lib:notify', source, {
            type = 'error',
            description = 'Spawner is on cooldown.',
        })
    end

    lastSpawn[source] = now
    TriggerClientEvent('pillbox_vehspawner:spawn', source, args.model)
end)
```

**`client.lua`**

```lua
RegisterNetEvent('pillbox_vehspawner:spawn', function(model)
    local hash = joaat(model)
    if not IsModelInCdimage(hash) or not IsModelAVehicle(hash) then
        return lib.notify({ type = 'error', description = ('Unknown vehicle: %s'):format(model) })
    end

    lib.requestModel(hash, 5000)

    local ped = cache.ped
    local coords = GetEntityCoords(ped)
    local veh = CreateVehicle(hash, coords.x, coords.y, coords.z, GetEntityHeading(ped), true, false)
    SetPedIntoVehicle(ped, veh, -1)
    SetModelAsNoLongerNeeded(hash)

    lib.notify({ type = 'success', description = ('Spawned %s'):format(model) })
end)
```

</details>

> Illustrative — real output varies with your prompt and the ox APIs in play. A SQL migration (with `oxmysql` reads/writes) and NUI are generated **only** when the resource actually needs persistence or an on-screen UI.

---

## 🎯 Why myRP.build?

- **🥇 ox-native, never a guess.** Built _exclusively_ for the ox ecosystem — `ox_core`, `ox_lib`, `ox_inventory`, `ox_target`, `oxmysql`. The agent writes against the real APIs, pulled from a curated knowledge base + a pgvector RAG index of the ox source. One ecosystem, done right — no framework grab-bag, no invented functions.
- **📦 Whole resources, not snippets.** Every generation is a complete, ready-to-`ensure` folder — client + server Lua, NUI, SQL, and an `fxmanifest.lua` that matches disk exactly.
- **🔁 Built to iterate.** Keep chatting. Each turn writes real files; **undo** + **auto-backup** make trying ideas free.
- **🚀 Deploys itself.** On finish it RCONs `refresh` + `ensure <resource>` and scans the console — you see "loaded clean" or the exact error, in-app.
- **💾 Local-first.** Files land on _your_ disk in _your_ server's `resources/`. No cloud editor, no remote sandbox.
- **🔌 Model-agnostic.** Runs on Mastra + the [Vercel AI SDK](https://sdk.vercel.ai/) — Anthropic, OpenAI, Google, Groq, local Ollama. Swap the whole pipeline with one env var.
- **🔒 Safe by construction.** The agent can only write inside your server's `resources/` folder — never anywhere else on your machine — and risky operations pause for approval ([how that works ↓](#-where-it-can-write-and-where-it-cant)).
- **🎙️ Voice in.** Speak the prompt — Whisper drops it in the box.

---

## 🧠 The pipeline

```
            Prompt
              │
              ▼
   ┌────────────────────────────────────────────┐
   │              Generator agent               │
   │            (one Mastra Agent)              │
   │                                            │
   │   on-demand Skills  ──►  ┌──────────────┐  │
   │   pgvector RAG (ox)  ──► │   workspace  │  │
   │                          │  fs · search │  │
   │                          │   · sandbox  │  │
   │                          └──────┬───────┘  │
   │                                 ▼          │
   │              writes Lua · NUI · fxmanifest │
   │                       · SQL  ──►  disk     │
   └────────────────────────────────────────────┘
              │
              ▼
   RCON refresh + ensure → console scan → result
```

Generation is **single-agent**: one Mastra `Agent` bound to a shared workspace writes everything — Lua, NUI, `fxmanifest.lua`, and SQL — itself. The workspace _derives_ the agent's filesystem, search, and sandbox tools automatically (no hand-maintained tool list, no token bloat from listing thirty tools it'll never call) and gives it a consistent view of the on-disk truth. It pulls ground-truth ox knowledge from on-demand Skills plus a pgvector RAG index of the ox source.

---

## 🔒 Where it can write (and where it can't)

There's no heavyweight container sandbox — and there doesn't need to be. The agent's filesystem is **confined to your FiveM server's `resources/` folder**: it generates into `resources/[local]/<name>/`, and it can _read_ sibling resources like `ox_lib` and `ox_core` for real context — but it **cannot write, move, or delete a single file anywhere else on your machine**. The blast radius is one folder, by construction.

The model never roams your disk. On top of the confinement:

- ✅ Writes are pinned to `resources/[local]/` — nothing outside your server folder, ever.
- ✅ Generation won't finish until `fxmanifest.lua` is present and matches the files on disk.
- ✅ The genuinely sensitive operations — running a shell command, deleting a file — **pause for your explicit approval**.

---

## 📚 The Skills system

myRP.build's knowledge about ox, Lua patterns, NUI, security, and resource templates lives in `skills/` as self-contained packages the agent loads on demand:

```
skills/
├── Framework + DB
│   ├── fw-ox-core/        ox_core player, money, jobs, commands
│   └── db-oxmysql/        oxmysql query patterns
├── ox suite
│   ├── ox-inventory/      inventory hooks, item creation
│   ├── ox-target/         zone/entity targeting
│   ├── ox-banking/        accounts, transactions
│   ├── ox-doorlock/       door locks + permissions
│   └── ox-fuel/           refueling integration
├── Patterns
│   ├── lua-quality/       effective-fivem-lua best practices
│   ├── nui-patterns/      HTML/CSS/JS overlay patterns
│   ├── security/          source validation, server authority, ACE
│   ├── fxmanifest/        manifest format + rules
│   └── server-practices/  server.cfg, performance, load order
└── Resource templates
    ├── business/  carwash/  drug-stash/  gang/  garage/
    ├── hud-design/  job/  npc-pack/  vehicle-spawner/
    └── lore/      lore-friendly naming for businesses/factions
```

Instead of stuffing every pattern into one giant system prompt, the agent loads only what the prompt at hand needs — small input, relevant context, ground-truth APIs.

---

## 🚀 Getting started

> Pre-release: no signed installer yet — `dist/` artifacts publish to [GitHub Releases](https://github.com/hamchowderr/myrp.build/releases) once the first signed build cuts. For now, run from source.

**Prerequisites:** Windows 10/11 · Node.js 20+ · a local FiveM server (or a path to one's `resources/` folder) · an [Anthropic API key](https://console.anthropic.com/) (or any [Vercel AI SDK](https://sdk.vercel.ai/) provider).

```bash
git clone https://github.com/hamchowderr/myrp.build.git
cd myrp.build
npm install
cp .env.example .env
```

To **self-host with your own key**, set two values in `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...   # your key — generation calls the model directly
FIVEM_STUDIO_DEV=1             # run the self-host path (skips sign-in + billing)
```

Then launch:

```bash
npm run dev                    # Electron + Vite HMR
```

> 💾 **Set up chat memory.** myRP.build is a multi-turn chat — follow-ups ("now add a cooldown"), saved threads, and conversation history all run on a local **Supabase** stack (the same Postgres the rest of the app uses). Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then `supabase start` (needs Docker) and `supabase db reset` to seed the local user. _(A one-shot generation will still run without it, but you'd lose memory between turns — so treat this as part of setup.)_

Point the app at your FiveM server on first launch, and you're building. Want a different model? Set `MASTRA_MODEL` (e.g. `openai/gpt-4-turbo`, `google/gemini-2.5-pro`, `ollama/llama3.3:70b`).

> 🤝 Hacking on myRP.build itself (the full prod-path stack with Supabase + auth)? See **[`CONTRIBUTING.md`](CONTRIBUTING.md)**.

---

## 🏠 Self-host it, or let us run it

Same app, same generator, same output — you just choose who holds the keys.

| | 🧑‍💻 **Self-hosted** | ☁️ **Managed** |
|---|---|---|
| **Setup** | Clone the source, bring your own API key | Sign in with Discord, pick a plan |
| **Inference** | Your key, called directly | Built in — no key needed |
| **Auth & billing** | None | Discord sign-in + Stripe |
| **Cost** | Your provider bill | One subscription |
| **Updates** | `git pull` | Automatic |
| **Your data** | Stays on your machine | Saved to your account in the cloud |
| **Best for** | Tinkerers & studios with their own keys | "Just let me build" |

**Self-hosting is first-class** — the full client, every feature, the same generator. The only thing the license draws a line at is reselling it _as_ a competing hosted service ([details ↓](#-license)).

→ **Self-host setup:** [`CONTRIBUTING.md`](CONTRIBUTING.md) · ☁️ **Managed:** [myrp.build](https://myrp.build)

---

## 🧱 Architecture

myRP.build is a **local Electron app** — the agent runs on your machine and writes resources to your disk. State that needs to persist — chat history, the ox knowledge index, and (for managed accounts) billing and teams — is backed by **Postgres / Supabase**: our cloud on the hosted plan, your own when you self-host.

```
src/
├─ main/                Electron main process
│  ├─ mastra/             Generator agent + shared workspace + cloud memory
│  │                      (specialist sub-agents built but flag-gated off)
│  ├─ ipc/                IPC handlers (chat, files, settings, fxdk, voice)
│  ├─ fxdk/               Win32 FFI primitives (shared memory, named pipes,
│  │                      nng RPC, CreateProcessW, D3D11 frame capture)
│  ├─ auto-deploy.ts      RCON refresh + ensure + console smoke scan
│  ├─ context.ts          server.cfg parsing (db / inventory / framework detect)
│  ├─ fileWriter.ts       Generation manifest + undo
│  └─ rag.ts              Retrieval over the ox knowledge index
├─ preload/             contextBridge — exposes window.api
└─ renderer/            React 19 + shadcn/ui + Tailwind v4
   ├─ App.tsx              Routes between self-host (dev-bypass) and the auth shell
   ├─ screens/             Generator, Settings, Setup
   ├─ components/chat/     Chat UI (messages, artifacts, suggestions)
   ├─ components/builder/  File explorer, NUI preview, game view, logs
   ├─ components/team/     Workspaces, members, invites
   └─ components/map/      Leaflet-rendered GTA V map with custom CRS

skills/                  Knowledge skills (loaded on demand by the agent)
supabase/                Cloud Postgres + Deno edge functions
                         (agent memory · RAG index · billing · teams)
tests/
├─ e2e/                  Playwright (packaged-exe prod-flow gate)
├─ mastra/               Agent tests (AIMock-intercepted, zero credits)
└─ fxdk/                 Win32 FFI module tests
```

---

## 🧪 Build & test

```bash
npm run typecheck            # tsconfig.node.json + tsconfig.web.json
npm run check                # Biome lint + format
npm run fallow               # dead-code / unused-dep scan
npm test                     # Vitest — unit + Mastra agent tests (AIMock, zero credits)
npm run test:e2e             # Playwright — packaged-exe prod-flow gate

npm run build                # compile-check build (mode=development)
npm run build:win            # signed Windows installer (.exe)
npm run build:unpack:nosign  # fast unpacked exe for local prod-flow iteration
```

Five testing tiers, cheapest first:

| Tier | What | Cost |
|---|---|---|
| **0. Static** | TypeScript + Biome + fallow + Deno | none |
| **1. Unit + agent** | Vitest, Mastra agents via AIMock | none |
| **2. Eval** | Generation-quality A/B harness | credits |
| **3. E2E** | Playwright against `dist/win-unpacked` | none |
| **4. Manual** | Full click-through + in-FiveM playtest | small |

Tier 0 + Tier 1 must be green before merge — CI gates it automatically.

---

## 🔭 Inspect & tune the agent (Mastra Studio)

The generator runs on [Mastra](https://mastra.ai/), so you can open it in **Mastra Studio** — a browser dashboard for poking at the agent without launching the desktop app. Handy for self-hosters who want to tune prompts or see exactly what the agent did.

```bash
supabase start      # local Supabase — backs memory + traces
npm run studio      # → http://localhost:4111
```

What you get:

- 💬 **Chat** with the generator directly (uses your `ANTHROPIC_API_KEY`)
- ✏️ **Edit & version the system prompt** — change the agent's instructions live, save a draft, publish
- 🧠 **Memory & threads** — every conversation, persisted to your local Supabase
- 🔭 **Traces** — per-run agent / tool / LLM spans, so you can see each step the agent took
- 🗂️ **Workspace, tools & skills** — browse the filesystem tools and the ox skills the agent loads
- ✅ **Quality scorers** — every generation is scored in the Evaluate tab: valid `fxmanifest.lua`, `luacheck`-clean Lua, and ox-only (no ESX/QBCore)

Point it at your server with `STUDIO_RESOURCES_ROOT=/path/to/server/resources` (defaults to a local FXServer path). Studio observes the **generation core** — the deploy and server-lifecycle tools are native to the desktop app and run only there.

---

## 🗺️ Roadmap

- 🎮 **In-app game preview** — launch and iterate on a resource without ever leaving myRP.build.
- 🤖 **Multi-agent generation** — the supervisor + specialist fan-out (context-scout, lua, nui, validator, security), once the architecture is doc-correct. Built today, flag-gated off.
- 🧠 **Fine-tuned ox model** — a model trained on real ox generations for sharper, cheaper, more on-style output.

---

## ❓ FAQ

- **Does it work with ESX or QBCore?** No — myRP.build targets **ox_overextended only** (`ox_core`, `ox_lib`, `ox_inventory`, `ox_target`, `oxmysql`). That focus is the point: the agent writes against APIs that actually exist instead of averaging across frameworks.
- **Do I need an API key?** Self-hosting, yes — bring your own (`ANTHROPIC_API_KEY`, or any Vercel AI SDK provider). On the managed plan, inference is built in.
- **Where do generated files go?** Into your server's `resources/[local]/<name>/`. The agent is confined to that `resources/` folder and can't touch anything else on your machine.
- **What models can I use?** **280+ models across 29 providers** — Anthropic, OpenAI, Google, Meta, Mistral, xAI, DeepSeek, Cohere, and more — all reachable through the [Vercel AI Gateway](https://vercel.com/ai-gateway). Browse the full list at **[vercel.com/ai-gateway/models](https://vercel.com/ai-gateway/models)** (live JSON: [`ai-gateway.vercel.sh/v1/models`](https://ai-gateway.vercel.sh/v1/models)). Switch with one env var — e.g. `MASTRA_MODEL=anthropic/claude-sonnet-4-6`, or any id from that list. Self-hosting, you can also run a local model via [Ollama](https://ollama.com/).
- **Does it run on macOS or Linux?** Windows only today — the FXDK integration uses Win32 FFI. Linux support is on the roadmap.
- **Is my data sent anywhere?** Self-hosted: generation runs against your key and your files stay on your disk; chat history persists to *your* local database. Managed: your chat history and account data live in your cloud account.
- **Can I sell what it builds?** Yes — the resources you generate are yours to use, ship, and sell. The license only draws a line at reselling **myRP.build itself** as a competing hosted service ([details ↓](#-license)).

---

## 🤝 Contributing

Contributions are welcome — see **[`CONTRIBUTING.md`](CONTRIBUTING.md)** for dev setup, the dev-vs-prod run modes, project conventions, and how PRs land.

This project is **source-available** under the [Functional Source License](#-license). Want early access, have a use case to share, or just want to hang out? [Open a discussion](https://github.com/hamchowderr/myrp.build/discussions) or **[join the Discord](https://discord.gg/4zUPdu5W3j)**. Public contributions require signing the CLA (so the project stays relicensable) — covered in the contributing guide.

---

## 🙏 Acknowledgments

myRP.build stands on the work of the teams who built the ecosystem it targets:

- **[Overextended](https://github.com/overextended)** — for `ox_core`, `ox_lib`, `ox_inventory`, `ox_target`, `oxmysql`, and the rest of the ox stack. myRP.build is built _around_ your frameworks — none of this exists without them. 💜
- **[Cfx.re](https://cfx.re/)** — for FiveM and the platform the entire RP community is built on.

Powered by [Mastra](https://mastra.ai/), the [Vercel AI SDK](https://sdk.vercel.ai/), and [Electron](https://www.electronjs.org/).

---

## 📜 License

**Source-available under the [Functional Source License](https://fsl.software/) (FSL-1.1-Apache-2.0).** You're free to **use, self-host, modify, and fork** the client. The only restriction is **Competing Use** — you can't run a competing hosted or commercial service from it. Each release **auto-converts to plain Apache-2.0 two years** after it ships, so the code becomes fully open over time.

A separate **paid commercial/embed license** covers what FSL excludes — hosting myRP.build for clients, white-labeling, or embedding it in another product. Prefer not to self-host at all? There's a managed [hosted subscription](#-self-host-it-or-let-us-run-it).

**The code you generate is yours.** The license above covers the *app*. It does **not** reach the resources the app generates for you — those belong to you, with no license claim or attribution required. See [`docs/GENERATED-CODE.md`](docs/GENERATED-CODE.md).

See the full [`LICENSE`](LICENSE) file for the exact terms.
