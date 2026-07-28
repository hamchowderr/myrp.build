---
paths:
  - "src/main/mastra/**"
  - "src/main/ipc/chat.ts"
---
# Mastra generation pipeline

Generation runs on **Mastra** (`@mastra/core`) + the **Vercel AI SDK v7** — NOT the Claude Agent SDK. There is no `query()`, no `src/main/agents/`, no `src/main/prompts/layer1-role.ts` (all migrated; don't reintroduce them).

- `agent.ts` — builds the supervisor `Agent`. Model is constructed via `createGateway` (Vercel AI Gateway → multi-provider) when a proxy/gateway key is present, else the bare model id. Keeps `instructions.providerOptions.anthropic.cacheControl` (the gateway forwards it to Anthropic; other providers namespace-ignore it).
- `workspace.ts` — Mastra Workspace; derives the agent's filesystem/search/sandbox tools. `skillPaths` = `oxSkillPaths(<root skills/>)`; `OX_SKILLS` is the ox-only allowlist.
- `prompt.ts` — system instructions (the former layer1-role + orchestrator content).
- `chat.ts` — the streaming bridge (`toAISdkStream`); `src/main/ipc/chat.ts` wires it to the renderer and the proxy/key guard.
- `storage/dev-auth.ts` — **dev-only** (`__DEV_BYPASS__`): signs the seeded local dev user (`supabase/seed.sql`, `dev@myrp.build`) into LOCAL Supabase and returns a JWT so dev chat uses the SAME `SupabaseMemoryStorage` adapter as prod (no raw `PostgresStore`, no shipped creds). The old `createFiveMMemory`/`PostgresStore` memory fallback was retired — it polluted the unified DB's schema.
- `observability.ts` — AI tracing, all first-party Mastra exporters. **Dev/self-host:** `ConsoleExporter`, plus `MastraPlatformExporter` against the operator's OWN Observe project when `MASTRA_PLATFORM_ACCESS_TOKEN` is set (never our proxy). **`MASTRA_PROJECT_ID` is required alongside it** — verified live: Observe answers 401 on the unscoped `/ai/spans/publish` and 200 on `/projects/<id>/ai/spans/publish` for the same bearer, so a token without a project id looks like a bad credential. **Prod:** `MastraStorageExporter` into the composite's `observability` domain, plus the platform exporter pointed at `supabase/functions/observability-proxy` when `OBSERVABILITY_PROXY_URL` is set — the proxy holds the platform token, the client sends only the user's own JWT (**no shipped credential**, same trick as `inference-proxy`). Gated on an authenticated run + `settings.shareGenerationTraces` (opt-out, default on): signed-out or opted-out builds construct no exporter at all. Prod sets `excludeSpanTypes: [MODEL_CHUNK]` — Mastra bills per event and chunk spans dominate volume. Prod instances are **fresh per run** (the storage exporter binds to that run's tenant/JWT); dev is a singleton.
- `storage/` — the **prod** cloud memory adapter (M2/M3). `createSupabaseMemoryStore(ctx)` composes a `MastraCompositeStore`: **`memory` domain = cloud Supabase** (`SupabaseMemoryStorage`; supabase-js with anon key + per-run JWT — reads via RLS tables `mastra_threads`/`mastra_messages`, writes via SECURITY DEFINER RPCs `mastra_save_*`; **no DB credential in the client**), **`workflows` domain = local `InMemoryStore`** (approval snapshots stay in-process by design). `resourceId = ws_<ws>__srv_<srv>`. `turn-tag.ts` prepends a spoof-proof `<turn author_id author_name functional_role>` (from the JWT identity + `my_workspace_role`) to each user message in shared team threads. See `supabase-billing.md`.

## Rules
- Model ids are provider-slashed (`anthropic/…`, `openai/…`). Don't hardcode a single provider or call a provider SDK directly.
- Agent behavior is tested through **AIMock** (in-process, deterministic, zero credits) — see `tests/mastra/`. Add/keep AIMock coverage rather than hitting the live API.
- Knowledge is loaded on demand from `skills/` (see `ox-only.md`) — don't stuff framework/DB/Lua knowledge into `prompt.ts`.
- **Cloud-first persistence, no shipped creds.** Prod memory + RAG read through cloud Supabase (anon key + per-run JWT; RLS reads, SECURITY DEFINER writes) — never a baked DB connection string. The direct `RAG_DATABASE_URL` pgvector path (`workspace.ts` hybrid search, `rag.ts` legacy) is **`__DEV_BYPASS__`-gated dev-only**; runtime RAG reads go through the `match_ox_corpus` RPC. Workflow approval snapshots are **always local** (`InMemoryStore`) — don't route them to the cloud.
