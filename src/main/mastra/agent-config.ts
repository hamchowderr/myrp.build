/**
 * myRP.build agent CORE config — the single source of truth shared by the app
 * (src/main/mastra/agent.ts) and Mastra Studio (studio/index.ts).
 *
 * WHY THIS EXISTS: Studio used to hand-rebuild a PARALLEL copy of the agent
 * (its own `new Agent({...})`), so it silently DRIFTED from the real one — a
 * processor added to agent.ts wouldn't show up in Studio, defeating the whole
 * point of Studio (test/edit the SAME agent you ship). This module owns
 * everything the two share — model resolution, system prompt + ox RAG,
 * TokenLimiter, memory, maxSteps, sub-agents — so they CANNOT drift.
 *
 * It is deliberately Electron-FREE: no native-tool imports (deploy /
 * server-lifecycle / install / smoke-test pull fxdk → electron + koffi, which
 * `mastra dev` can't bundle). The app layers those native tools on top in
 * agent.ts; Studio omits them (it can't run them anyway). Everything ELSE is
 * identical by construction.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { RegexFilterProcessor, TokenLimiter, ToolCallFilter } from "@mastra/core/processors";
import type { AnyWorkspace } from "@mastra/core/workspace";
import { createGateway } from "ai";
import { DANGEROUS_SHELL_RULES } from "./guardrails";
import { FIVEM_INSTRUCTIONS } from "./prompt";
import { RollingCacheBreakpoint } from "./rolling-cache";
import { createSubAgents } from "./sub-agents";

/** Default model (validated live). ox generation favors Sonnet; override via MASTRA_MODEL. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

/**
 * Context-window safety net. `maxSteps` bounds the loop COUNT; this bounds
 * the per-call INPUT TOKENS. Without it, two things grow unbounded and inflate cost:
 * (1) multi-turn memory history (lastMessages:20 caps count, not size — file-content
 * tool results are large), and (2) accumulated tool results across a 30-step run.
 * TokenLimiter trims oldest non-system messages each step, ALWAYS preserving the
 * system message (instructions + ox RAG). Default leaves generous headroom under
 * Sonnet's window so it only engages in extreme cases; override via MASTRA_TOKEN_LIMIT.
 */
const DEFAULT_TOKEN_LIMIT = 150_000;
export const TOKEN_LIMIT =
  Number.parseInt(process.env.MASTRA_TOKEN_LIMIT ?? "", 10) || DEFAULT_TOKEN_LIMIT;

/**
 * Prod inference-proxy config. When set, the agent's model is built with the
 * Anthropic provider pointed at our Supabase edge function (which holds the gateway
 * key + meters usage), authed with the user's session token. The function forwards to
 * the gateway's Anthropic Messages endpoint, so cache_control passthrough is preserved.
 * Omit entirely for the direct-key path (dev/owner) — gated upstream in ipc/chat.ts.
 */
export interface ProxyConfig {
  /** Base URL of the deployed edge function. */
  url: string;
  /** The user's session token (sent as x-api-key by the Anthropic provider). */
  token: string;
  /** Supabase anon key for Kong routing (sent as the `apikey` header). */
  anonKey?: string;
}

export interface FiveMAgentOptions {
  /**
   * ox_overextended RAG snippets (from queryOxContext) to inject as ground-truth
   * API/source reference — preserves the retrieval win on the Mastra path.
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
   * Prod inference-proxy. When set, generation routes through the Supabase
   * edge function instead of the direct Anthropic key. Gated off dev-bypass upstream.
   */
  proxyConfig?: ProxyConfig;
  /**
   * Conversation Memory. When provided, the agent persists/recalls message
   * history so follow-up turns (ai:message) carry prior context. Pair with
   * `agent.stream(prompt, { memory: { thread, resource } })`. Omit for one-shot.
   */
  memory?: import("@mastra/memory").Memory;
  /**
   * Wire the specialist sub-agents onto the supervisor. Default `false`
   * — we START SINGLE-AGENT: one agent with the read-write workspace writes
   * everything itself (no delegation mismatch, no memory/storage dependency).
   *
   * IMPORTANT: the current multi-agent wiring shares ONE workspace across the
   * supervisor + sub-agents, which is NOT the doc-correct supervisor pattern
   * (supervisor should be a read-only coordinator; specialists own their own
   * workspaces; default `includeSubAgentToolResultsInModelContext: false` hides
   * subagent writes from the supervisor — the root cause of the layout bug).
   * Only flip this on as part of the sub-agent architecture rework.
   */
  useSubAgents?: boolean;
  /**
   * The server's resources/ root. When set, the APP gets a `validate_resource`
   * tool for the VERIFY step (assembled in agent.ts — native layer).
   */
  resourcesRoot?: string;
  /** RCON config for the app's approval-gated `deploy_resource` tool (agent.ts). */
  deployConfig?: import("./tools/deploy").DeployToolConfig;
  /** Server lifecycle config for the app's start/stop/restart tools (agent.ts). */
  serverConfig?: import("./tools/server-lifecycle").ServerLifecycleConfig;
  /** Config for the app's approval-gated install_resource tool (agent.ts). */
  installConfig?: import("./tools/install").InstallToolConfig;
  /** Config for the app's approval-gated import_schema tool (agent.ts). */
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

/** The gateway provider's model type — what `new Agent({ model })` accepts. */
type SupervisorModel = ReturnType<ReturnType<typeof createGateway>>;

/**
 * Resolve the ONE inference path: the Vercel AI Gateway (provider-agnostic —
 * routes by the model's `provider/` prefix and forwards provider options like
 * the Anthropic prompt-cache marker). No bare-provider SDK fallback — dev and
 * prod share the gateway, so a misconfigured run fails fast.
 *   Prod:      gateway → our Supabase edge proxy (auth + per-workspace quota + metering).
 *   Dev/owner/Studio: gateway directly with VERCEL_GATEWAY_KEY (free monthly credits).
 *   Tests:     OPENAI_BASE_URL points an OpenAI-compatible provider at AIMock.
 * Construction never touches the network; only throws when NO path is configured.
 */
function resolveModel(modelId: string, proxyConfig?: ProxyConfig): SupervisorModel {
  const gatewayKey = process.env.VERCEL_GATEWAY_KEY ?? process.env.AI_GATEWAY_API_KEY;
  const openaiBaseURL = process.env.OPENAI_BASE_URL;
  if (proxyConfig) {
    return createGateway({
      baseURL: proxyConfig.url,
      apiKey: proxyConfig.token,
      ...(proxyConfig.anonKey ? { headers: { apikey: proxyConfig.anonKey } } : {}),
    })(modelId);
  }
  if (gatewayKey) {
    return createGateway({ apiKey: gatewayKey })(modelId);
  }
  if (openaiBaseURL) {
    // OpenAI-compatible endpoint override (AIMock in tests; or any local OpenAI-
    // compatible gateway). `.chat()` forces /v1/chat/completions — ai-sdk's default
    // openai() uses the Responses API, which the mock doesn't drive here.
    // NOTE: this MUST stay createOpenAI — driving AIMock through createGateway
    // fails (GatewayInternalServerError: Not found); @ai-sdk/gateway uses a
    // gateway-specific protocol/route, not plain /v1/chat/completions. @ai-sdk/openai
    // is itself the Vercel AI SDK, so this is not a non-SDK fallback.
    return createOpenAI({
      baseURL: openaiBaseURL,
      apiKey: process.env.OPENAI_API_KEY || "mock",
    }).chat(modelId) as unknown as SupervisorModel;
  }
  throw new Error(
    "No inference path configured. Set VERCEL_GATEWAY_KEY for local dev (free " +
      "monthly credits — vercel.com/ai-gateway), or sign in to use the hosted " +
      "proxy. The bare ANTHROPIC_API_KEY fallback was removed.",
  );
}

/**
 * Build the Electron-free CORE of the myRP.build supervisor agent bound to
 * `workspace` — everything the app and Studio share. The app spreads native
 * tools on top (agent.ts); Studio consumes it as-is (+ scorers).
 *
 * The return type is deliberately INFERRED (not annotated as the Agent config
 * type): annotating widens the output/defaultOptions generics so the spread
 * `new Agent({...core})` stops matching `Agent<..., undefined, ...>`. Inference
 * keeps the precise literal shape, so both call sites construct the right Agent.
 *
 * Pass the Workspace from `createFiveMWorkspace(resourcesRoot)`; call
 * `await workspace.init()` before streaming. Inject ox RAG via `opts.ragContext`.
 */
export function buildFiveMAgentConfig(workspace: AnyWorkspace, opts: FiveMAgentOptions = {}) {
  const instructionsText =
    opts.ragContext && opts.ragContext.length > 0
      ? `${FIVEM_INSTRUCTIONS}\n\n${formatOxKnowledge(opts.ragContext)}`
      : FIVEM_INSTRUCTIONS;

  const modelId = opts.model || process.env.MASTRA_MODEL || DEFAULT_MODEL;
  const model = resolveModel(modelId, opts.proxyConfig);

  return {
    id: "fivem-generator",
    name: "myRP.build Generator",
    description:
      "Senior FiveM developer that builds complete ox_overextended resources and writes them to the server's resources/ directory, and manages the local FXServer.",
    // System message with Anthropic ephemeral prompt caching: the instructions +
    // ox RAG (~10k tokens) are identical across every step of a multi-step
    // generation, so caching them turns steps 2..N into cheap cache reads.
    instructions: {
      // `as const` narrows role to the literal "system" — without the
      // `new Agent({...})` contextual position it would widen to `string`.
      role: "system" as const,
      content: instructionsText,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } },
    },
    model,
    workspace,
    // Input-processor pipeline (runs in array order). Two phases:
    //   processInput      — once per turn, on the assembled input (recalled
    //                       history + the new user message).
    //   processInputStep  — every step of the agentic loop, before each LLM call.
    inputProcessors: [
      // aku (defense-in-depth): deterministic, zero-LLM-cost block of
      // unambiguously destructive shell commands in USER INPUT. The exec approval
      // gate stays the primary, source-agnostic control (it also catches commands
      // the agent reads mid-run, which an input processor can't see).
      new RegexFilterProcessor({
        rules: DANGEROUS_SHELL_RULES,
        strategy: "block",
        phase: "input",
      }),
      // sop: strip noisy tool-call payloads from RECALLED history. ToolCallFilter's
      // default runs only on processInput (turn start), so shared-thread recall
      // (lastMessages:20 + semanticRecall) drops its large tool results, while the
      // LIVE multi-step tool results are preserved (filterAfterToolSteps is off).
      // NB: Mastra unified memory processors onto the agent — the old
      // `new Memory({ processors })` now THROWS, so this is the correct home.
      new ToolCallFilter(),
      // Context-window cap — bounds input tokens per step; preserves system.
      new TokenLimiter(TOKEN_LIMIT),
      // 5o2.2: rolling Anthropic cache breakpoint on the last message each step so
      // the conversation prefix caches (steps 2..N read it). MUST come after the
      // TokenLimiter so it marks the post-trim last message. Kill-switch:
      // MYRP_DISABLE_ROLLING_CACHE=1 drops it (ops escape hatch + A/B control run).
      ...(process.env.MYRP_DISABLE_ROLLING_CACHE === "1" ? [] : [new RollingCacheBreakpoint()]),
    ],
    // Conversation memory for multi-turn follow-ups; omitted = one-shot.
    ...(opts.memory ? { memory: opts.memory } : {}),
    // maxSteps lives here (not per stream() call) so every caller — runGeneration
    // and the e2e harness — gets the same loop budget for multi-file resources.
    defaultOptions: { maxSteps: 30 },
    // Single-agent by default; sub-agents only when explicitly opted in (and not
    // until the doc-correct multi-agent architecture lands).
    ...(opts.useSubAgents ? { agents: createSubAgents(workspace) } : {}),
  };
}
