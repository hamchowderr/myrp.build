# In-FiveM "Official" Testing

How we verify a **generated resource actually runs in a live FiveM server + client** —
as opposed to the test *tiers* (0–2), which only check generation *quality* statically
(luacheck, structure, AIMock). This is "Tier 4 — manual/live" from the root `CLAUDE.md`,
made concrete.

There are **two layers**. Run the automated one constantly; run the manual one before
calling a resource "shippable".

```
            ┌─────────────────────────────────────────────┐
 generate → │  Layer 1: Deploy & Smoke-test  (automated)   │ → catches ~most failures
            │  ensure → scan console → pass/fail           │   (won't load, Lua errors,
            └─────────────────────────────────────────────┘    missing deps, bad manifest)
                                │ clean
                                ▼
            ┌─────────────────────────────────────────────┐
            │  Layer 2: In-client playtest   (manual)      │ → the human gate
            │  join localhost:30120, exercise the resource │   (does the gameplay work)
            └─────────────────────────────────────────────┘
```

---

## Layer 1 — Deploy & Smoke-test (automated, no game client)

**What it is:** deploy the resource to the running FXServer via RCON, then scan the
server console for the *asynchronous* load result and return a structured pass/fail.

**Why it catches most failures:** the real load errors — Lua syntax/runtime, missing
`ox_lib`/dependencies, `fxmanifest` mistakes, parse failures — surface on the FXServer's
**stdout after `ensure` returns**, not in the synchronous RCON reply. The smoke-test
snapshots the console buffer, sends `ensure`, polls for new lines, and matches them
against a curated error-pattern library (`src/main/smoke-scan.ts`).

**Code:**
- `src/main/smoke-scan.ts` — pure `scanConsoleForLoadErrors(entries, name)` + `LOAD_ERROR_PATTERNS` (unit-tested).
- `src/main/smoke-test.ts` — `deployAndVerifyResource(name, port, rconPassword, waitMs?)`.
- IPC: `window.api.smokeTestResource(resourceName)` → `SmokeResult` (reads port/RCON from settings).

**`SmokeResult`:**
```ts
{ ok, deployed, loadSuccess, startedConfirmed, loadError?, matchedPattern?, consoleSnippet?, secondsWaited }
```

**Prerequisites:** FXServer running (`server online` in the status bar) and an
`rcon_password` set in Settings. No game client needed.

**Interpreting results:**
| Result | Meaning |
| --- | --- |
| `ok: true, startedConfirmed: true` | Loaded clean, server confirmed start. ✅ |
| `ok: true, startedConfirmed: false` | No errors seen, but no explicit "Started resource" — server may be offline or the resource produced no output. Re-check the server is up. |
| `ok: false` | `loadError` + `consoleSnippet` show the failure — feed back to the agent to fix. |

What Layer 1 does **not** prove: that the gameplay behaves correctly. A resource can
load cleanly and still do the wrong thing in-game. That's Layer 2.

---

## Layer 2 — In-client playtest (manual, the human gate)

FiveM has **no headless/automated client** — actually playing a resource requires a
human in the FiveM client. This is the irreducible manual step and the final gate
before "shippable".

### Setup (once)
1. FXServer running locally (the app's **Start Server**, or the status bar shows `server online`).
2. The resource deployed (Layer 1, or the agent's **Deploy & Restart**) — confirm it
   `ensure`d without errors first.
3. Launch the **FiveM client** (`FiveM.exe`).

### Join
4. In the client: **Direct Connect** → `localhost:30120` (or the configured server port).
5. Wait for spawn. Open the **client console with F8** — keep it visible to catch
   client-side Lua errors as you test.

### Exercise the resource (pick the rows that apply)
| Resource type | What to verify in-game |
| --- | --- |
| **Command** (`RegisterCommand`) | Run the command (e.g. `/heal`, `/giveweapon`). Confirm the effect + any chat/notify feedback. Try bad/edge args. |
| **HUD / NUI overlay** | The overlay renders, updates live (health/armor/etc.), and toggles/hides as designed. No z-index/CSS breakage. |
| **`ox_target`** | Approach the entity/zone — the target eye/options appear; selecting an option fires the action. |
| **`ox_lib` UI** (context/menu/input/progress) | Menus open, inputs submit, progress bars complete/cancel correctly. |
| **Inventory (`ox_inventory`)** | Items appear/usable; give/remove reflects in the inventory UI; metadata correct. |
| **Database (`oxmysql`)** | The action persists — check the row in the DB (the app's DB tools / a SQL client). Re-join and confirm it survived. |
| **Server events / callbacks** | Trigger the flow end-to-end (client → server → client). Watch both consoles. |

### Confirm
6. **No errors** in the F8 client console or the server console during the test.
7. The resource does what the prompt asked — including the obvious edge cases.
8. `stop`/`restart` the resource cleanly (no leaked threads, no errors on unload).

### Sign-off
A resource is **shippable** when: Layer 1 is green, the applicable Layer 2 rows pass,
and both consoles are clean. If anything fails, capture the console error and feed it
back to the agent to regenerate/fix, then re-run both layers.

---

## Where this fits

- Root `CLAUDE.md` → **Testing tiers** table: this doc is "Tier 4 — Manual/live", with
  Layer 1 now automatable.
- Layer 1 belongs in the everyday loop (cheap, no client). Layer 2 is a pre-release /
  pre-"done" gate for any resource a user will actually run.

## Roadmap
- ✅ Deploy & smoke-test core
- ⬜ Smoke-test UI trigger + agent self-verify tool
- ⬜ Server-side functional probes — trigger a resource's commands/exports via RCON and
  check console/DB responses, narrowing the manual surface (`al1`)
