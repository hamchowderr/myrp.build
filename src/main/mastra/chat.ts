/**
 * Chat streaming entrypoint for the AI-Elements UI path.
 *
 * Unlike runGeneration (which maps Mastra chunks to our legacy StreamMessage
 * contract), this yields AI SDK **v6 UIMessage chunks** via @mastra/ai-sdk's
 * toAISdkStream — so the renderer can drive `useChat` + AI Elements with zero
 * hand-rolled stream mapping. Chunks are forwarded to the renderer over IPC and
 * reassembled into a ReadableStream by the custom ChatTransport.
 *
 * Memory: the chat session's `threadId` (= useChat chatId) is the Mastra memory
 * thread, so follow-ups carry context server-side and we only send the new turn.
 */
import { toAISdkStream } from "@mastra/ai-sdk";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { createFiveMAgent } from "./agent";
import { createAndInitWorkspace } from "./workspace";

const AGENT_KEY = "fivem-generator";

export interface RunChatStreamOptions {
  /** Conversation thread id (useChat chatId) — Mastra memory thread. */
  threadId: string;
  /** Provider model string (e.g. "anthropic/claude-opus-4-6"). Defaults in the agent. */
  model?: string;
  /** Prod inference-proxy config (Supabase edge fn). Omit for the direct-key path. */
  proxyConfig?: import("./agent").ProxyConfig;
  /** Resource/owner id for memory (defaults to the local single-user id). */
  resourceId?: string;
  /**
   * Per-tenant Supabase chat Memory resolved in ipc/chat.ts from a per-run JWT
   * (cloud in prod; local Supabase via the seeded dev JWT in dev-bypass).
   * Omitted only when memory can't be resolved → single-turn, no persistence.
   */
  memory?: import("@mastra/memory").Memory;
  /** ox RAG snippets to inject (preserves the RAG retrieval). */
  ragContext?: string[];
  /** Absolute ox skill-folder paths to expose. */
  skillPaths?: string[];
  /** RCON config for the approval-gated deploy_resource tool. */
  deployConfig?: import("./tools/deploy").DeployToolConfig;
  /** Config for the approval-gated server lifecycle tools. */
  serverConfig?: import("./tools/server-lifecycle").ServerLifecycleConfig;
  /** Config for the approval-gated install_resource tool. */
  installConfig?: import("./tools/install").InstallToolConfig;
  /** Config for the approval-gated import_schema tool. */
  importSchemaConfig?: import("./tools/import-schema").ImportSchemaToolConfig;
  /** Paths to auto-index for search (app passes [local] only). */
  indexPaths?: string[];
  /** Abort the agentic loop (wired to chat:cancel). */
  abortSignal?: AbortSignal;
  /** Gate sensitive ops (execute_command + delete) behind approve/decline. */
  requireApproval?: boolean;
  /**
   * Called when a sensitive tool pauses for approval. Resolves true (approve)
   * or false (decline) once the user decides. Only invoked when requireApproval
   * is on and the agent actually calls a gated tool.
   */
  awaitApproval?: (runId: string) => Promise<boolean>;
  /** Receives each AI SDK v6 UIMessage chunk as it streams. */
  onChunk: (chunk: unknown) => void;
}

/**
 * Run one chat turn and stream AI SDK v6 UIMessage chunks via `onChunk`.
 *
 * @param prompt        the user's new message (memory carries prior turns)
 * @param resourcesRoot the server's resources/ directory (workspace basePath)
 */
export async function runChatStream(
  prompt: string,
  resourcesRoot: string,
  opts: RunChatStreamOptions,
): Promise<void> {
  // create + init with BM25 fallback if hybrid init fails (RAG DB unreachable, odm).
  const workspace = await createAndInitWorkspace(resourcesRoot, {
    requireApproval: opts.requireApproval,
    skillPaths: opts.skillPaths,
    indexPaths: opts.indexPaths,
  });
  try {
    // Per-tenant cloud Memory resolved in ipc/chat.ts (anon key + per-run JWT;
    // local Supabase in dev via the seeded dev JWT, cloud in prod — v1f9). When
    // undefined (memory unconfigured/unreachable) the run is single-turn.
    const memory = opts.memory;
    const baseAgent = createFiveMAgent(workspace, {
      ragContext: opts.ragContext,
      model: opts.model,
      proxyConfig: opts.proxyConfig,
      memory,
      resourcesRoot,
      deployConfig: opts.deployConfig,
      serverConfig: opts.serverConfig,
      installConfig: opts.installConfig,
      importSchemaConfig: opts.importSchemaConfig,
    });
    // Approval needs snapshot persistence on a Mastra INSTANCE (a standalone
    // agent + memory is not enough — verified: "No storage is configured on this
    // Mastra instance"). The approve/decline suspend→resume cycle is entirely
    // single-process and single-turn — it runs inside THIS one runChatStream call
    // (the loop below), so the workflow snapshot only needs LOCAL, in-process
    // storage. Cloud-backing the snapshot would just add resume-poll latency
    // (Mastra polls loadWorkflowSnapshot for ~2s) for zero benefit, and previously
    // it silently no-op'd in packaged builds (no RAG_DATABASE_URL) → the
    // "No storage is configured" crash. InMemoryStore is @mastra/core's full
    // in-memory composite store (despite living in the "mock" module). Durable
    // cloud chat MEMORY is a separate concern handled elsewhere.
    const needsApprovalStorage = Boolean(
      opts.requireApproval ||
        opts.deployConfig ||
        opts.serverConfig ||
        opts.installConfig ||
        opts.importSchemaConfig,
    );
    const agent = needsApprovalStorage
      ? new Mastra({
          storage: new InMemoryStore(),
          agents: { [AGENT_KEY]: baseAgent },
        }).getAgent(AGENT_KEY)
      : baseAgent;
    const streamOpts = {
      ...(memory
        ? {
            memory: {
              thread: opts.threadId,
              // resourceId always accompanies a resolved cloud memory; fall back
              // defensively to the single-user local id.
              resource: opts.resourceId ?? "myrp-build-local",
            },
          }
        : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    };

    // Pump a Mastra output to UIMessage chunks. Returns the runId if the stream
    // paused for a tool approval (tool-approval-request), else undefined.
    const pump = async (
      output: import("@mastra/core/stream").MastraModelOutput,
    ): Promise<string | undefined> => {
      let pausedRunId: string | undefined;
      const uiStream = toAISdkStream(output, {
        from: "agent",
        version: "v6",
        sendReasoning: true,
      });
      const reader = uiStream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const type = (value as { type?: string }).type;
        if (type === "tool-approval-request") {
          pausedRunId = output.runId;
        }
        opts.onChunk(value);
        // Provider/stream errors arrive as an "error" chunk (e.g. Anthropic out of
        // credits, invalid key, rate limit) — they do NOT throw. Surface them by
        // throwing so the chat.ts catch reports a clear chat:error to the user
        // instead of the stream just ending silently.
        if (type === "error") {
          const text = (value as { errorText?: string }).errorText ?? "";
          throw new Error(text || "The AI provider returned an error.");
        }
      }
      return pausedRunId;
    };

    let output = await agent.stream(prompt, streamOpts);
    let pausedRunId = await pump(output);
    // Approve/decline loop: resume the same run until no approval is pending.
    // Bounded so a misbehaving loop can't spin forever.
    for (let i = 0; pausedRunId && i < 20; i++) {
      const approved = opts.awaitApproval ? await opts.awaitApproval(pausedRunId) : false; // no handler → safe default is decline
      output = approved
        ? await agent.approveToolCall({ runId: pausedRunId })
        : await agent.declineToolCall({ runId: pausedRunId });
      pausedRunId = await pump(output);
    }
  } finally {
    await workspace.destroy().catch(() => {});
  }
}
