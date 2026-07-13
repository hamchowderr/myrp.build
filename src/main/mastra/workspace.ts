/**
 * Mastra Workspace factory for myRP.build (migration, Phase 1).
 *
 * Replaces the raw @anthropic-ai/sdk + custom 4-tool loop (orchestrator.ts) with
 * an embedded Mastra Workspace running in the Electron main process. The Workspace
 * ships read/write/list/grep/edit/delete filesystem tools plus a sandbox for shell
 * execution — no custom tool implementations needed.
 *
 * API verified against @mastra/core@1.36.0:
 *   - `Workspace` is a class (NOT a `createWorkspace()` factory).
 *   - `LocalFilesystem` / `LocalSandbox` are real providers bundled in core
 *     (separate @mastra/workspace-fs-* packages are only for remote backends).
 *   - Approval is configured per-tool via `tools: { <name>: { requireApproval } }`
 *     — this REPLACES the provider-level requireApproval/requireReadBeforeWrite
 *     flags the original plan assumed.
 *   - Tool names are `mastra_workspace_*` (relevant to renderer remapping).
 *
 * Call `await workspace.init()` before use (connects filesystem + sandbox, builds
 * the search index over autoIndexPaths).
 */

import type { WorkspaceConfig } from "@mastra/core/workspace";
import { LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS, Workspace } from "@mastra/core/workspace";
import { PgVector } from "@mastra/pg";
import { embedMany } from "ai";
import { Client } from "pg";
import { EMBEDDER } from "./embedder";

/** Valid SQL identifier — the workspace's pgvector index lives alongside ox_corpus. */
const SEARCH_INDEX_NAME = "fivem_workspace_search";

/**
 * Batch embedder over local fastembed (CPU, no key, no network — see embedder.ts,
 * the same model rag.ts and the ox_corpus ingest use). Branded `batch: true` so the
 * workspace search engine embeds whole index rebuilds in one call, not one-per-file.
 */
function createFastembedEmbedder() {
  const fn = async (texts: string[]): Promise<number[][]> => {
    // embedMany preserves input order, so no re-sort is needed.
    const { embeddings } = await embedMany({ model: EMBEDDER, values: texts });
    return embeddings;
  };
  return Object.assign(fn, { batch: true as const, maxBatchSize: 256 });
}

/**
 * Hybrid (BM25 + semantic) search config — restores QMD's semantic recall over
 * the server's OWN resources. Uses pgvector on RAG_DATABASE_URL
 * + local fastembed embeddings (no API key).
 *
 * DEV-ONLY: this is the ONE remaining direct
 * RAG_DATABASE_URL pgvector consumer, and @mastra/pg's PgVector fundamentally
 * needs a raw connection string (it can't go through supabase-js / an RPC). The
 * shipped client must carry NO DB credential, so this path is hard-gated to dev
 * (`__DEV_BYPASS__`) AND env-gated (RAG_DATABASE_URL). In any packaged build
 * dotenv never loads, `__DEV_BYPASS__` compiles to `false`, and hybrid is never
 * enabled by any prod caller (runChatStream omits `hybrid`), so this returns {} →
 * BM25-only. Semantic ox knowledge in prod comes from the cloud match_ox_corpus
 * RPC (rag.ts queryOxContext), not here.
 */
function hybridSearchConfig(): Partial<
  Pick<WorkspaceConfig, "vectorStore" | "embedder" | "searchIndexName">
> {
  const dbUrl = process.env.RAG_DATABASE_URL;
  // Never open a direct pgvector connection outside dev — no DB credential ships.
  if (!__DEV_BYPASS__ || !dbUrl) return {};
  return {
    vectorStore: new PgVector({
      id: "fivem-workspace",
      connectionString: dbUrl,
    }),
    embedder: createFastembedEmbedder(),
    searchIndexName: SEARCH_INDEX_NAME,
  };
}

/**
 * Build a configured (uninitialized) Workspace rooted at `resourcesRoot`.
 *
 * `resourcesRoot` MUST be the FiveM server's `resources/` directory, NOT just
 * `resources/[local]/`. Rooting at `resources/` lets the agent read sibling
 * resources (ox_lib, ox_inventory, ox_core) for real context, while
 * `contained: true` still confines every operation — including writes — to
 * within that root, blocking path-traversal and symlink escapes.
 *
 * Generated resources land under `[local]/<name>/` relative to this root, which
 * is where the existing fileWriter/manifest flow already expects them.
 *
 * Skills (ox knowledge) and the Lua LSP (bundled lua-language-server) are both
 * wired below when available.
 */
export interface FiveMWorkspaceOptions {
  /** @deprecated No longer gates writes — writes always land immediately. Accepted for callers; ignored. */
  interactive?: boolean;
  /**
   * Gate SENSITIVE ops (shell execute_command + filesystem delete) behind
   * approve/decline (the Settings toggle). File writes are NEVER gated — they
   * always land immediately. Requires a storage provider for snapshots (we have
   * PostgresStore via memory). Default `true` (secure default; opt-out via the
   * Settings approval toggle).
   */
  requireApproval?: boolean;
  /**
   * Paths to auto-index for search on init(). Defaults to [resourcesRoot], but
   * the app passes ONLY the user's [local] dir — indexing the entire server
   * resources/ tree (which includes [ox]/ox_lib's hundreds of files) embeds
   * everything and blocks the first generation for minutes. basePath stays the
   * resources root so the agent can still READ sibling resources on demand.
   */
  indexPaths?: string[];
  /**
   * Absolute paths to Agent-Skill folders (each containing a SKILL.md). When set,
   * the workspace exposes skill/skill_search/skill_read tools and lists the skills
   * in the agent's system message. Each path is added to the filesystem's
   * `allowedPaths` so discovery can read it while `contained: true` still
   * sandboxes writes to `resourcesRoot`. Skills are BM25/vector-indexed for
   * skill_search when search is configured.
   *
   * Pass only ox-relevant skills (see OX_SKILLS) — the product is ox_overextended
   * only, so non-ox framework / non-oxmysql skills must NOT be exposed to the agent.
   *
   * NOTE: each SKILL.md must have a `name` matching its folder per the Agent
   * Skills spec — Mastra rejects (skips) skills without it.
   */
  skillPaths?: string[];
  /**
   * Opt into hybrid (BM25 + pgvector semantic) search. Default `false` — the app
   * runs BM25-only because:
   *   - hybrid re-embeds the indexed corpus into pgvector on EVERY init() (~26s +
   *     embedding spend; not incremental), which is the "streaming hang" users saw;
   *   - empirically (tests/search-ab.ts) the vector index is polluted (duplicate
   *     path forms + out-of-scope files leaked from a shared/stale pgvector table),
   *     so it returns worse results than clean, in-memory BM25 over [local].
   * BM25 init is ~215ms and returns correctly-scoped [local] hits. Semantic ox
   * knowledge already comes from the RAG pipeline (queryOxContext), not here.
   *
   * Revive this only with the persistent-workspace path:
   * init once per session + a cleanly-scoped index. Still env-gated: even when
   * `true`, hybrid only engages in dev when RAG_DATABASE_URL is set.
   */
  hybrid?: boolean;
}

/**
 * ox_overextended-relevant skill folder names (subset of .claude/skills). The
 * Non-ox framework / non-oxmysql skills are intentionally excluded — the
 * product targets ox only.
 */
export const OX_SKILLS = [
  // Knowledge skills.
  "lua-quality",
  "fxmanifest",
  "security",
  "fw-ox-core",
  "db-oxmysql",
  // Official MariaDB knowledge skills (MIT, vendored from github.com/MariaDB/skills).
  // The generated-server game DB is MariaDB via oxmysql, so these sharpen the SQL
  // the agent writes. Migration/infra/agent-plumbing skills from upstream are
  // intentionally NOT vendored (oracle-to-mariadb, replication-and-ha, vector, mcp).
  "mysql-to-mariadb",
  "mariadb-features",
  "mariadb-query-optimization",
  "mariadb-system-versioned-tables",
  "ox-banking",
  "ox-doorlock",
  "ox-fuel",
  "ox-target",
  "ox-inventory",
  "nui-patterns",
  "hud-design",
  "lore",
  "server-practices",
  // Resource-recipe skills: full ox_overextended build blueprints.
  "carwash",
  "vehicle-spawner",
  "garage",
  "npc-pack",
  "drug-stash",
  "business",
  "job",
  "gang",
] as const;

/** Resolve the ox skill folder paths under a skills root directory. */
export function oxSkillPaths(skillsRoot: string): string[] {
  return OX_SKILLS.map((name) => `${skillsRoot}/${name}`);
}

/**
 * Lua LSP config: run the bundled lua-language-server as an in-loop LSP over the
 * agent's edit tools, so it sees real Lua diagnostics while generating (the Mastra
 * LSP-client URI bug that blocked this is fixed upstream, #17813). Lua isn't a built-in
 * Mastra server, so register it as a custom server pointed at LUALS_PATH (resolved in
 * src/main/index.ts to the bundled binary). LocalSandbox provides the process manager
 * LSP needs. Returns {} when unresolved (e.g. Mastra Studio / tests) so LSP is simply off.
 */
function luaLspConfig(): Pick<WorkspaceConfig, "lsp"> | Record<string, never> {
  const bin = process.env.LUALS_PATH;
  if (!bin) return {};
  return {
    lsp: {
      servers: {
        lua: {
          id: "lua-language-server",
          name: "Lua Language Server",
          languageIds: ["lua"],
          extensions: [".lua"],
          markers: ["fxmanifest.lua", ".luarc.json", ".git"],
          // Quote the path — the bundled binary lives under a resources dir that can
          // contain spaces. Run with no args → LuaLS defaults to stdio LSP mode.
          command: `"${bin}"`,
        },
      },
    },
  };
}

export function createFiveMWorkspace(
  resourcesRoot: string,
  opts: FiveMWorkspaceOptions = {},
): Workspace {
  const approval = opts.requireApproval ?? true;
  const skillPaths = opts.skillPaths?.length ? opts.skillPaths : undefined;
  return new Workspace({
    name: "myrp-build",
    filesystem: new LocalFilesystem({
      basePath: resourcesRoot,
      contained: true,
      // Let skill discovery read the skill folders (outside resourcesRoot) while
      // writes stay sandboxed to resourcesRoot.
      ...(skillPaths ? { allowedPaths: skillPaths } : {}),
    }),
    sandbox: new LocalSandbox({ workingDirectory: resourcesRoot }),
    // Hybrid search over the server's resources: BM25 keyword always on,
    // plus pgvector + local fastembed semantic when (in dev) RAG_DATABASE_URL is
    // set (restores QMD's semantic recall). Fail-safe to BM25-only otherwise.
    bm25: true,
    autoIndexPaths: opts.indexPaths ?? [resourcesRoot],
    // BM25-only by default (fast, clean, correctly scoped). Hybrid is opt-in and
    // still env-gated — see FiveMWorkspaceOptions.hybrid.
    ...(opts.hybrid ? hybridSearchConfig() : {}),
    // ox-only FiveM knowledge skills exposed as skill/skill_search/skill_read.
    ...(skillPaths ? { skills: skillPaths } : {}),
    // In-loop Lua diagnostics via the bundled lua-language-server; off when unresolved.
    ...luaLspConfig(),
    tools: {
      // Writes ALWAYS land immediately — the product's instant-generation feel.
      [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
        enabled: true,
        requireApproval: false,
        requireReadBeforeWrite: false,
      },
      // Sensitive ops gated behind approval when enabled (the Settings toggle):
      // shell commands and deletes pause for approve/decline. Writes never do.
      [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
        enabled: true,
        requireApproval: approval,
      },
      [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
        enabled: true,
        requireApproval: approval,
      },
    },
  });
}

/**
 * Is the RAG pgvector DB actually reachable? A short-timeout connect probe, used
 * to decide whether hybrid search is safe to enable. Returns
 * false (never throws) when RAG_DATABASE_URL is unset or the DB can't be reached.
 */
async function ragDbReachable(): Promise<boolean> {
  // Dev-only: the hybrid pgvector path it gates is dev-only (no DB credential
  // ships) — never probe a direct connection in a packaged build.
  if (!__DEV_BYPASS__) return false;
  const url = process.env.RAG_DATABASE_URL;
  if (!url) return false;
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 1500,
  });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    return false;
  }
}

/**
 * Create the workspace and init() it, degrading to BM25-only when HYBRID is
 * requested but the RAG DB is unreachable. init() does NOT
 * eagerly connect — a set-but-down DB only blows up later at SEARCH time (the
 * hybrid engine embeds the query then hits pgvector), which would break the agent
 * mid-generation. So we PREFLIGHT the DB here and drop to BM25-only before
 * building, matching the fail-safe posture of rag.ts and createFiveMMemory.
 */
export async function createAndInitWorkspace(
  resourcesRoot: string,
  opts: FiveMWorkspaceOptions = {},
): Promise<Workspace> {
  let effective = opts;
  if (opts.hybrid && !(await ragDbReachable())) {
    console.warn(
      "[workspace] hybrid requested but RAG DB unreachable — degrading to BM25-only (odm).",
    );
    effective = { ...opts, hybrid: false };
  }
  const ws = createFiveMWorkspace(resourcesRoot, effective);
  try {
    await ws.init();
    return ws;
  } catch (err) {
    // Hybrid init embeds the corpus via local fastembed — a first-run model
    // download or onnxruntime init failure would otherwise crash the whole
    // generation. The DB preflight above can't catch embedder
    // failures. Degrade to BM25-only and retry so generation continues.
    if (!effective.hybrid) throw err; // BM25-only already — nothing left to drop
    console.warn(
      "[workspace] hybrid init failed (likely embedder init) — degrading to BM25-only (1er):",
      err instanceof Error ? err.message : err,
    );
    await ws.destroy().catch(() => {});
    const bm25 = createFiveMWorkspace(resourcesRoot, {
      ...opts,
      hybrid: false,
    });
    await bm25.init();
    return bm25;
  }
}
