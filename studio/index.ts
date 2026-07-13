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
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { MastraEditor } from "@mastra/editor";
import { Memory } from "@mastra/memory";
import { MastraStorageExporter, Observability } from "@mastra/observability";
import { PostgresStoreVNext } from "@mastra/pg";
import { buildFiveMAgentConfig } from "../src/main/mastra/agent-config";
import { createAndInitWorkspace, oxSkillPaths } from "../src/main/mastra/workspace";
import { studioScorerRegistry, studioScorers } from "./scorers";

// Point at your FiveM server's resources/ folder. Override with the env var;
// the fallback is a typical local FXServer path.
const root =
  process.env.STUDIO_RESOURCES_ROOT ??
  "C:/FXServer/txData/FiveMBasicServerCFXDefault_B89B02.base/resources";

// ox skills (ox-only allowlist) from the tracked root skills/ dir.
//
// PATH TRAP (verified): `mastra dev --dir studio` BUNDLES this file to
// <repo>/.mastra/output/index.mjs and runs it FROM THERE, so BOTH
// process.cwd()-relative AND import.meta.url-relative "../skills" resolve to
// nonexistent dirs (.mastra/skills) and the workspace silently loads ZERO
// skills. The robust fix is to WALK UP from the module location until we hit
// the ancestor that actually contains skills/ (repo root) — works whether
// bundled (.mastra/output → .mastra → repo) or run in place.
function findSkillsRoot(): string {
  if (process.env.STUDIO_SKILLS_ROOT) return process.env.STUDIO_SKILLS_ROOT;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "skills");
    // fw-ox-core is a canonical ox skill folder — its presence identifies the
    // real skills/ dir (not some unrelated "skills" folder up the tree).
    if (existsSync(join(candidate, "fw-ox-core", "SKILL.md"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), "skills"); // last-resort fallback
}
const skillsRoot = findSkillsRoot();

const workspace = await createAndInitWorkspace(root, {
  indexPaths: [],
  skillPaths: oxSkillPaths(skillsRoot),
});

// Local Supabase Postgres (same stack as the app), isolated in mastra_studio.
//
// PostgresStoreVNext (not the plain PostgresStore): it composes the primary
// store (memory / workflows / scores) with the v-next observability domain,
// which is the ONLY Postgres path that implements metrics + logs + traces.
// The plain PostgresStore inherits @mastra/core's base observability, whose
// getMetric*/logs methods THROW ("does not support metric aggregation") — that
// was the source of Studio's "Metrics/Logs not available with your current
// storage" errors. `observability` is required; for local dev we point it at
// the SAME Postgres (a dedicated instance only matters at production volume —
// PostgresStoreVNext logs a one-time collision warning, which is expected here).
const connectionString = process.env.RAG_DATABASE_URL;
const store = connectionString
  ? new PostgresStoreVNext({
      id: "studio",
      connectionString,
      schemaName: "mastra_studio",
      observability: { connectionString, schemaName: "mastra_studio" },
    })
  : undefined;

if (!store) {
  console.warn(
    "[studio] RAG_DATABASE_URL unset — running WITHOUT memory/traces. Start the " +
      "local Supabase stack (`supabase start`) and set RAG_DATABASE_URL to enable them.",
  );
}

const memory = store ? new Memory({ storage: store, options: { lastMessages: 20 } }) : undefined;

// Build the generator from the SHARED, Electron-free core (buildFiveMAgentConfig)
// — the SAME config the app's createFiveMAgent uses: model resolution (Vercel AI
// Gateway via VERCEL_GATEWAY_KEY, so Studio no longer needs a bare ANTHROPIC_API_KEY),
// system prompt + ox RAG, TokenLimiter input processor, maxSteps, sub-agents. This
// is what makes Studio FAITHFUL — a processor/setting added to the app shows up here
// automatically instead of drifting. The only thing Studio omits is the native,
// Electron/FFI-bound tools (deploy/server-lifecycle/…), which it can't run anyway.
const generator = new Agent({
  ...buildFiveMAgentConfig(workspace, { ...(memory ? { memory } : {}) }),
  // Quality scorers (studio/scorers/) — show up in Studio's Evaluate tab and
  // run live on each generation: fxmanifest-present, luacheck-pass, ox-only.
  scorers: studioScorers,
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
