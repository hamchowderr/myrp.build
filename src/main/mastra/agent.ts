/**
 * FiveM Studio supervisor agent (epic 55x.3).
 *
 * Replaces the Agent-SDK orchestrator (agents/orchestrator.ts) with a Mastra
 * Agent. The agent derives its filesystem / sandbox / search tools AUTOMATICALLY
 * from the assigned Workspace — there is no manual tool list to maintain or to
 * blow the input-token budget (the 15-20k Agent-SDK tool overhead the Mar 17
 * rewrite was fighting).
 *
 * Sub-agents are intentionally NOT wired here. Per the 55x.24 decision the
 * specialist layer (context-scout, lua/nui/lore specialists, validator,
 * security-auditor, docs-writer) will be ported to Mastra sub-agents and passed
 * via the `agents` map in that issue. Until then the supervisor does the work
 * directly with its workspace tools — the prompt is written to be valid either
 * way, so this agent is functional standalone.
 *
 * Model: a Mastra magic string ("anthropic/<id>") so AIMock can intercept it in
 * the test tier (55x.19 — the google/* provider hardcodes its base URL and
 * can't be intercepted). Override with MASTRA_MODEL. The exact id is resolved
 * lazily at stream() time; construction never touches the network, so this
 * factory is safe to call (and typecheck) without credentials.
 */

import { Agent } from "@mastra/core/agent";
import { TokenLimiter } from "@mastra/core/processors";
import type { AnyWorkspace } from "@mastra/core/workspace";
import { createGateway } from "ai";
import { FIVEM_INSTRUCTIONS } from "./prompt";
import { createSubAgents } from "./sub-agents";
import { createDeployTool } from "./tools/deploy";
import { createImportSchemaTool } from "./tools/import-schema";
import { createInstallTool } from "./tools/install";
import { createServerLifecycleTools } from "./tools/server-lifecycle";
import { createSmokeTestTool } from "./tools/smoke-test";
import { createValidatorTool } from "./tools/validator";

/** Default model (validated live). ox generation favors Sonnet; override via MASTRA_MODEL. */
const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

/**
 * Prod inference-proxy config (ok7). When set, the agent's model is built with the
 * Anthropic provider pointed at our Supabase edge function (which holds the gateway
 * key + meters usage), authed with the user's Clerk token. The function forwards to
 * the gateway's Anthropic Messages endpoint, so cache_control passthrough is preserved.
 * Omit entirely for the direct-key path (dev/owner) — gated upstream in ipc/chat.ts.
 */
export interface ProxyConfig {
  /** Base URL of the deployed edge function. */
  url: string;
  /** The user's Clerk session token (sent as x-api-key by the Anthropic provider). */
  token: string;
  /** Supabase anon key for Kong routing (sent as the `apikey` header). */
  anonKey?: string;
}

/**
 * Context-window safety net (55x.9). `maxSteps` bounds the loop COUNT; this bounds
 * the per-call INPUT TOKENS. Without it, two things grow unbounded and inflate cost:
 * (1) multi-turn memory history (lastMessages:20 caps count, not size — file-content
 * tool results are large), and (2) accumulated tool results across a 30-step run.
 * TokenLimiter trims oldest non-system messages each step, ALWAYS preserving the
 * system message (instructions + ox RAG). Default leaves generous headroom under
 * Sonnet's window so it only engages in extreme cases; override via MASTRA_TOKEN_LIMIT.
 */
const DEFAULT_TOKEN_LIMIT = 150_000;
const TOKEN_LIMIT =
  Number.parseInt(process.env.MASTRA_TOKEN_LIMIT ?? "", 10) || DEFAULT_TOKEN_LIMIT;

export interface FiveMAgentOptions {
  /**
   * ox_overextended RAG snippets (from queryOxContext) to inject as ground-truth
   * API/source reference — preserves the zhk.6 retrieval win on the Mastra path.
   * The agent's own workspace search covers the SERVER's resources; this covers
   * the ox ecosystem corpus.
   */
  ragContext?: string[];
  /**
   * Provider model string (Mastra magic string, e.g. "anthropic/claude-opus-4-6"),
   * chosen per-turn in the UI. Falls back to MASTRA_MODEL then DEFAULT_MODEL.
   */
  model?: string;
  /**
   * Prod inference-proxy (ok7). When set, generation routes through the Supabase
   * edge function instead of the direct Anthropic key. Gated off dev-bypass upstream.
   */
  proxyConfig?: ProxyConfig;
  /**
   * Conversation Memory (oeb). When provided, the agent persists/recalls message
   * history so follow-up turns (ai:message) carry prior context. Pair with
   * `agent.stream(prompt, { memory: { thread, resource } })`. Omit for one-shot.
   */
  memory?: import("@mastra/memory").Memory;
  /**
   * Wire the specialist sub-agents (55x.24) onto the supervisor. Default `false`
   * — we START SINGLE-AGENT: one agent with the read-write workspace writes
   * everything itself (no delegation mismatch, no memory/storage dependency).
   *
   * IMPORTANT: the current multi-agent wiring shares ONE workspace across the
   * supervisor + sub-agents, which is NOT the doc-correct supervisor pattern
   * (supervisor should be a read-only coordinator; specialists own their own
   * workspaces; default `includeSubAgentToolResultsInModelContext: false` hides
   * subagent writes from the supervisor — the root cause of the layout bug, oft).
   * Only flip this on as part of the 55x.24 architecture rework.
   */
  useSubAgents?: boolean;
  /**
   * The server's resources/ root. When set, the agent gets a `validate_resource`
   * tool (zhk.8) for the VERIFY step's static-check + auto-repair loop.
   */
  resourcesRoot?: string;
  /**
   * RCON config for the approval-gated `deploy_resource` tool (445.2). When set,
   * the agent can make a built resource live via `ensure <resource>` — always
   * pausing for approval first. Omit to disable in-app deploy (e.g. tests).
   * See vault: "FiveM Studio - Agent Server Interaction".
   */
  deployConfig?: import("./tools/deploy").DeployToolConfig;
  /**
   * Server lifecycle config for the approval-gated start/stop/restart tools and
   * the read-only server_status tool (fivem-studio-w2s). When set, the agent can
   * manage the local FXServer (each lifecycle op pauses for approval). Omit to
   * disable (e.g. tests). Amends the 2026-05-23 contract — see vault.
   */
  serverConfig?: import("./tools/server-lifecycle").ServerLifecycleConfig;
  /**
   * Config for the approval-gated install_resource tool (fivem-studio-8m1) — lets
   * the agent install a missing ox dependency (download release -> [ox] -> ensure).
   * Omit to disable.
   */
  installConfig?: import("./tools/install").InstallToolConfig;
  /**
   * Config for the approval-gated import_schema tool (fivem-studio-h5k) — lets the
   * agent run a resource's SQL schema against the server DB (via the connection
   * string in server.cfg) so it doesn't tell the user to import it by hand. Omit
   * to disable (e.g. tests, or when no server.cfg is available).
   */
  importSchemaConfig?: import("./tools/import-schema").ImportSchemaToolConfig;
}

/** Wrap retrieved ox snippets in the same <ox_knowledge> block the legacy prompt used. */
function formatOxKnowledge(snippets: string[]): string {
  return `<ox_knowledge>
The following are authoritative ox_overextended reference snippets (API docs and source patterns), retrieved by semantic search for THIS request.
Use them as ground truth for ox_lib / ox_core / oxmysql / ox_target / ox_inventory usage — prefer these patterns over anything from memory.

${snippets.join("\n\n")}
</ox_knowledge>`;
}

/**
 * Build the FiveM Studio supervisor agent bound to `workspace`.
 *
 * Pass the Workspace from `createFiveMWorkspace(resourcesRoot)`. Call
 * `await workspace.init()` before streaming so the filesystem, sandbox, and
 * search index are ready. Optionally inject ox RAG context via `opts.ragContext`.
 */
export function createFiveMAgent(workspace: AnyWorkspace, opts: FiveMAgentOptions = {}): Agent {
  const instructionsText =
    opts.ragContext && opts.ragContext.length > 0
      ? `${FIVEM_INSTRUCTIONS}\n\n${formatOxKnowledge(opts.ragContext)}`
      : FIVEM_INSTRUCTIONS;

  const modelId = opts.model || process.env.MASTRA_MODEL || DEFAULT_MODEL;
  // Unified Vercel AI Gateway provider — one path for ANY model (anthropic/*,
  // openai/*, …). The gateway routes by the model's `provider/` prefix and forwards
  // provider-specific options (e.g. the Anthropic prompt-cache marker below).
  //   Prod: point the gateway at our Supabase edge proxy (Supabase token as the key,
  //         anon key for Kong) — it adds auth + per-workspace quota + metering.
  //   Dev/owner: hit the gateway directly with the gateway key (VERCEL_GATEWAY_KEY).
  //         Fall back to the bare magic-string id (Anthropic via ANTHROPIC_API_KEY)
  //         only when no gateway key is present.
  const gatewayKey = process.env.VERCEL_GATEWAY_KEY ?? process.env.AI_GATEWAY_API_KEY;
  let model: ReturnType<ReturnType<typeof createGateway>> | string;
  if (opts.proxyConfig) {
    model = createGateway({
      baseURL: opts.proxyConfig.url,
      apiKey: opts.proxyConfig.token,
      ...(opts.proxyConfig.anonKey ? { headers: { apikey: opts.proxyConfig.anonKey } } : {}),
    })(modelId);
  } else if (gatewayKey) {
    model = createGateway({ apiKey: gatewayKey })(modelId);
  } else {
    model = modelId;
  }

  return new Agent({
    id: "fivem-generator",
    name: "myRP.build Generator",
    description:
      "Senior FiveM developer that builds complete ox_overextended resources and writes them to the server's resources/ directory, and manages the local FXServer.",
    // System message with Anthropic ephemeral prompt caching: the instructions +
    // ox RAG (~10k tokens) are identical across every step of a multi-step
    // generation, so caching them turns steps 2..N into cheap cache reads.
    instructions: {
      role: "system",
      content: instructionsText,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    model,
    workspace,
    // Context-window cap (55x.9) — bounds input tokens per step; preserves system.
    inputProcessors: [new TokenLimiter(TOKEN_LIMIT)],
    // Conversation memory for multi-turn follow-ups (oeb); omitted = one-shot.
    ...(opts.memory ? { memory: opts.memory } : {}),
    // maxSteps lives here (not per stream() call) so every caller — runGeneration
    // and the e2e harness — gets the same loop budget for multi-file resources.
    defaultOptions: { maxSteps: 30 },
    // Agent tools: static validator (zhk.8) + approval-gated deploy (445.2) +
    // approval-gated server lifecycle (fivem-studio-w2s).
    ...(() => {
      // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool factories — Mastra validates shapes at runtime.
      const tools: Record<string, any> = {};
      if (opts.resourcesRoot) tools.validate_resource = createValidatorTool(opts.resourcesRoot);
      if (opts.deployConfig) {
        tools.deploy_resource = createDeployTool(opts.deployConfig);
        // Non-gated runtime self-verify (epic 5hx): the agent ensures the resource
        // and scans the console for async load errors, then fixes + re-tests.
        tools.smoke_test_resource = createSmokeTestTool(opts.deployConfig);
      }
      if (opts.serverConfig) Object.assign(tools, createServerLifecycleTools(opts.serverConfig));
      if (opts.installConfig) tools.install_resource = createInstallTool(opts.installConfig);
      if (opts.importSchemaConfig)
        tools.import_schema = createImportSchemaTool(opts.importSchemaConfig);
      return Object.keys(tools).length > 0 ? { tools } : {};
    })(),
    // Single-agent by default; sub-agents only when explicitly opted in (and not
    // until the doc-correct multi-agent architecture lands — see 55x.24).
    ...(opts.useSubAgents ? { agents: createSubAgents(workspace) } : {}),
  });
}
