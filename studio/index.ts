// Mastra Studio entry — `npm run studio` (mastra dev --dir studio).
//
// Studio is a dev-time inspector for the generator agent: chat with it, edit
// and version its system prompt, browse memory/threads, and watch per-run
// traces — all in a browser at http://localhost:4111. It is NOT shipped in the
// packaged app (the @mastra/editor / @mastra/observability deps are devDeps).
//
// WORKSPACE-FIRST: this builds the generator agent DIRECTLY from the
// Electron-free pieces — the Mastra Workspace (filesystem/search/sandbox tools)
// + the system prompt + the model. It deliberately does NOT import
// src/main/mastra/agent.ts, because that statically pulls the deploy/
// server-lifecycle tools → the fxdk orchestrator → `electron` + native FFI,
// which `mastra dev` can't bundle. So Studio observes the CORE generation loop
// (read/write/list/grep/edit Lua·NUI·SQL·fxmanifest). The native/Electron-bound
// tools (deploy, server-lifecycle) run only inside the app and are out of scope.
//
// MEMORY + TRACES = LOCAL SUPABASE. The whole stack is Supabase, so Studio's
// Memory/threads + Traces are backed by a PostgresStore pointed at the LOCAL
// Supabase Postgres (RAG_DATABASE_URL → 127.0.0.1:55322), isolated in its own
// `mastra_studio` schema so it never touches the app's RLS-managed mastra_*
// tables (owned by the cloud SupabaseMemoryStorage adapter + SECURITY DEFINER
// RPCs). Requires `supabase start` (the local stack running).
import { join } from "node:path";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { MastraEditor } from "@mastra/editor";
import { Memory } from "@mastra/memory";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { PostgresStore } from "@mastra/pg";
import { FIVEM_INSTRUCTIONS } from "../src/main/mastra/prompt";
import { createAndInitWorkspace, oxSkillPaths } from "../src/main/mastra/workspace";
import { studioScorerRegistry, studioScorers } from "./scorers";

// Point at your FiveM server's resources/ folder. Override with the env var;
// the fallback is a typical local FXServer path.
const root =
  process.env.STUDIO_RESOURCES_ROOT ??
  "C:/FXServer/txData/FiveMBasicServerCFXDefault_B89B02.base/resources";

// ox skills (ox-only allowlist) from the tracked root skills/ dir. In the app
// these resolve under app.getAppPath(); outside Electron, off the project root
// (mastra dev runs from there). Wiring them makes Studio's workspace faithful —
// the agent can load the same ox knowledge it uses in-app.
const skillsRoot = process.env.STUDIO_SKILLS_ROOT ?? join(process.cwd(), "skills");

const workspace = await createAndInitWorkspace(root, {
  indexPaths: [],
  skillPaths: oxSkillPaths(skillsRoot),
});

// Local Supabase Postgres (same stack as the app), isolated in mastra_studio.
const connectionString = process.env.RAG_DATABASE_URL;
const store = connectionString
  ? new PostgresStore({ id: "studio", connectionString, schemaName: "mastra_studio" })
  : undefined;

if (!store) {
  console.warn(
    "[studio] RAG_DATABASE_URL unset — running WITHOUT memory/traces. Start the " +
      "local Supabase stack (`supabase start`) and set RAG_DATABASE_URL to enable them.",
  );
}

const memory = store ? new Memory({ storage: store, options: { lastMessages: 20 } }) : undefined;

const generator = new Agent({
  id: "fivem-generator",
  name: "myRP.build Generator (workspace)",
  description:
    "FiveM ox_overextended resource generator — workspace tools only (deploy/server-lifecycle are injected only in the app).",
  instructions: FIVEM_INSTRUCTIONS,
  model: process.env.MASTRA_MODEL ?? "anthropic/claude-sonnet-4-6",
  workspace,
  // Quality scorers (studio/scorers/) — show up in Studio's Evaluate tab and
  // run live on each generation: fxmanifest-present, luacheck-pass, ox-only.
  scorers: studioScorers,
  ...(memory ? { memory } : {}),
});

// Observability / AI tracing (@mastra/observability). MastraStorageExporter
// writes spans to the Mastra instance's storage → the local-Supabase
// mastra_ai_spans table. Lights up Studio's Traces view (per-run agent/tool/
// LLM spans) once you chat. Gated on storage, like memory.
const observability = store
  ? new Observability({
      configs: {
        default: {
          serviceName: "myrp-build-studio",
          exporters: [new MastraStorageExporter()],
        },
      },
    })
  : undefined;

// MastraEditor (@mastra/editor) turns Studio's system-prompt panel from
// read-only into editable — edit/version the agent's instructions, prompt
// blocks, tools, and variables live in Studio. Persists to the configured
// storage backend (the local-Supabase PostgresStore above → mastra_agents/
// _versions/prompt_blocks). Studio-only dev tool; not in the packaged app.
export const mastra = new Mastra({
  agents: { generator },
  editor: new MastraEditor(),
  // Register the raw scorers so they're listed in Studio's Scorers page
  // (the agent's `scorers` map above is what runs them live on each generation).
  scorers: studioScorerRegistry,
  ...(observability ? { observability } : {}),
  ...(store ? { storage: store } : {}),
});
