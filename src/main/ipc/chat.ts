/**
 * IPC for the generation chat path. Bridges the renderer to a main-process
 * Mastra Harness turn:
 *
 *   renderer --chat:start--> here --> buildHarnessRuntime + sendHarnessTurn
 *      --> webContents.send("harness:event") --> the renderer's harness hook
 *      (reduceHarnessEvent) --> HarnessChat + AI Elements.
 *
 * Per-turn we send only the new user message; the Mastra memory thread (= the
 * chat id) carries prior context server-side. The legacy single-agent
 * runChatStream path (agent.stream + chat:chunk transport) has been removed.
 */

import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { Memory } from "@mastra/memory";
import { createGateway } from "ai";
import { app, ipcMain } from "electron";
import log from "electron-log/main";
import { getActiveServer } from "../../renderer/src/lib/server-registry";
import { resolveServerRconPassword } from "../context";
import { rateGeneration } from "../generation-log";
import {
  buildHarnessRuntime,
  disposeHarnessRuntime,
  type HarnessRuntime,
  type HarnessWireEvent,
  resumeHarnessSuspension,
  sendHarnessTurn,
} from "../mastra/chat-harness";
import { EMBEDDER } from "../mastra/embedder";
import { createFiveMObservability } from "../mastra/observability";
import {
  createRunClient,
  createSupabaseMemoryStore,
  deriveAuthorName,
  type RunStorageContext,
  SupabaseVector,
  TEAM_PARTICIPANTS_TEMPLATE,
  type TurnIdentity,
  tagUserMessage,
} from "../mastra/storage";
import { getDevAccessToken } from "../mastra/storage/dev-auth";
import { oxSkillPaths } from "../mastra/workspace";
import { keepAwake, notify } from "../native-features";
import { type OxSource, queryOxContext } from "../rag";
import { readSettings, state } from "../shared-state";
import { createWriteTracker, finalizeGeneration } from "./generation-finalize";

/** Cheap, fast model for the OM Observer + Reflector background agents. */
const OBSERVER_MODEL_ID = "anthropic/claude-haiku-4-5";

/** Instructions for Mastra's generateTitle — auto-names each thread so a future
 *  conversation list/search is legible. 3-6 words, plain text, ox-flavored. */
const TITLE_INSTRUCTIONS =
  "Generate a concise 3-6 word title summarizing this conversation from the user's first message. " +
  "Plain text only — no markdown, no surrounding quotes, no trailing punctuation. " +
  "Name the FiveM resource or task (e.g. 'Car dealership with test drives', 'Police MDT warrant lookup').";

/** Prod inference-proxy config (mirrors the agent's): the edge fn URL + the user's
 *  Supabase token as the gateway key + the anon key for Kong. */
type ProxyCfg = { url: string; token: string; anonKey?: string };

/** Headers for a memory-op gateway call routed through the proxy: mark it free
 *  (x-myrp-memory-op) so the proxy skips quota + metering, + Kong's apikey. */
function memoryProxyHeaders(proxy: ProxyCfg): Record<string, string> {
  return { "x-myrp-memory-op": "1", ...(proxy.anonKey ? { apikey: proxy.anonKey } : {}) };
}

/**
 * The semantic-recall embedder: local fastembed (bge-small-en-v1.5, 384-dim) via
 * the shared {@link EMBEDDER} — CPU-only, free, no API key, nothing leaves the
 * machine. Always available (no proxy/key gate), so semantic recall is now always
 * on: the per-message API cost that kept it disabled is gone. Same model as
 * rag.ts / the ox_corpus index — the SupabaseVector table is sized to match (384).
 */
function resolveSemanticRecallEmbedder() {
  return EMBEDDER;
}

/**
 * Build the OM observer/reflector model, or undefined when no model path exists.
 * PROD: route through the inference proxy (free memory-op, no quota/metering). DEV/owner:
 * direct Vercel AI Gateway (VERCEL_GATEWAY_KEY). Runs an extra LLM call per turn,
 * absorbed as free internal infra (owner decision).
 */
function resolveObserverModel(proxy?: ProxyCfg) {
  if (proxy) {
    return createGateway({
      baseURL: proxy.url,
      apiKey: proxy.token,
      headers: memoryProxyHeaders(proxy),
    })(OBSERVER_MODEL_ID);
  }
  const gatewayKey = process.env.VERCEL_GATEWAY_KEY ?? process.env.AI_GATEWAY_API_KEY;
  if (gatewayKey) return createGateway({ apiKey: gatewayKey })(OBSERVER_MODEL_ID);
  return undefined;
}

/**
 * Resolve the cheap follow-up/suggestion model for a thread-side op (chat:suggestFollowups),
 * routing exactly like the agent: the prod inference proxy (free memory-op, no quota/metering)
 * when not in dev-bypass and a token + PROXY_BASE_URL are present, else a direct gateway key.
 * No bare-provider fallback. Returns undefined when no inference path exists (→ caller
 * silently shows no suggestions).
 */
export function resolveFollowupModel(accessToken: string | undefined) {
  const proxyBase = process.env.PROXY_BASE_URL;
  const proxyConfig: ProxyCfg | undefined =
    !__DEV_BYPASS__ && accessToken && proxyBase
      ? {
          url: proxyBase,
          token: accessToken,
          anonKey: process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY,
        }
      : undefined;
  return resolveObserverModel(proxyConfig);
}

/** Map raw upstream LLM provider errors to a clear, actionable chat message. */
function friendlyLlmError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("credit balance is too low") || s.includes("billing"))
    return "Inference: out of credits. Top up your Vercel AI Gateway credits (or provider account) and try again.";
  if (s.includes("invalid x-api-key") || s.includes("authentication") || s.includes("401"))
    return "Inference: invalid or missing key. Check VERCEL_GATEWAY_KEY, or sign in to use the hosted proxy.";
  if (s.includes("rate limit") || s.includes("429") || s.includes("overloaded"))
    return "Inference: rate limited or overloaded. Wait a moment and try again.";
  return `Generation failed: ${raw}`;
}

/** Resolved cloud-memory context for a chat run. */
export interface CloudMemory {
  memory: Memory;
  /** The composite store backing `memory` (cloud Supabase memory + InMemory
   *  workflows). Reused as the Harness `storage` so the Harness path persists to
   *  the SAME store as Memory. */
  storage: MastraCompositeStore;
  resourceId: string;
  /** The run's authenticated Supabase client (anon key + JWT) — reused for the
   *  RAG read RPC so a single client serves memory + corpus retrieval. */
  client: RunStorageContext["client"];
  /** Authenticated identity for the <turn> attribution tag. Built from
   *  auth.uid()/email + the member's workspace role — never from a client arg. */
  turnIdentity: TurnIdentity;
}

/**
 * Resolve durable per-tenant cloud chat memory for this run.
 *
 * Builds a Supabase run client from the user's JWT (anon key + Bearer JWT — no DB
 * credential), resolves the authenticated identity via auth.getUser() and the
 * active workspace (explicit `workspaceId`, else the personal workspace via
 * rpc('get_subscription')), then returns a cloud Memory backed by
 * SupabaseMemoryStorage. For now the scope is the personal workspace with a null
 * server; resourceId is `ws_<workspaceId>`.
 *
 * Returns undefined (→ caller degrades to the bare/no-cloud path) when there's no
 * JWT (dev-bypass), the publishable URL/anon key aren't baked in, or any step
 * fails — generation must never break just because memory can't be persisted.
 */
export async function resolveCloudMemory(
  accessToken: string | undefined,
  workspaceId: string | undefined,
  serverPath: string | undefined,
  proxyConfig?: ProxyCfg,
  existingClient?: RunStorageContext["client"],
): Promise<CloudMemory | undefined> {
  if (!accessToken) return undefined;
  try {
    // Reuse a caller-supplied client (so chat:start can run RAG on the SAME client
    // concurrently — 71v) or build one from the JWT. Cheap either way (no network).
    const client = existingClient ?? createRunClient(accessToken);
    if (!client) return undefined; // url/anon key not configured

    const { data: userData, error: userErr } = await client.auth.getUser();
    if (userErr || !userData.user) {
      log.warn("[chat] cloud memory: getUser failed, continuing without it:", userErr);
      return undefined;
    }
    const authorId = userData.user.id;
    const authorEmail = userData.user.email ?? "";

    // Active workspace: prefer the explicit one from the renderer (workspace
    // switcher); fall back to the caller's personal workspace via get_subscription
    // (also self-provisions on first use).
    let ws = workspaceId;
    if (!ws) {
      const { data, error } = await client.rpc("get_subscription");
      if (error || !data || data.length === 0) {
        log.warn("[chat] cloud memory: workspace resolve failed, continuing without it:", error);
        return undefined;
      }
      ws = data[0].workspace_id;
    }

    // Resolve (or create) the server row for this client's configured server.
    // serverId scopes the resourceId so a team's chat memory is SHARED
    // per-server (a workspace can have multiple servers). client_server_key is a
    // stable hash of the local server path. ensure_server is idempotent +
    // membership-checked; any failure is non-fatal — degrade to workspace scope.
    let serverId: string | null = null;
    if (serverPath) {
      const clientServerKey = createHash("sha256").update(serverPath).digest("hex").slice(0, 32);
      const { data: srvId, error: srvErr } = await client.rpc("ensure_server", {
        p_workspace_id: ws,
        p_client_server_key: clientServerKey,
        p_name: basename(serverPath),
      });
      if (srvErr || typeof srvId !== "string") {
        log.warn("[chat] cloud memory: ensure_server failed, continuing workspace-scoped:", srvErr);
      } else {
        serverId = srvId;
      }
    }
    const resourceId = serverId ? `ws_${ws}__srv_${serverId}` : `ws_${ws}`;
    const ctx: RunStorageContext = {
      client,
      workspaceId: ws,
      serverId,
      resourceId,
      authorId,
      authorEmail,
    };

    // Resolve the member's role in the active workspace for the <turn> tag
    // — server-side via my_workspace_role(auth.uid()), NEVER from a client arg, so
    // attribution can't be spoofed. Non-fatal: default to 'developer' on failure.
    let functionalRole = "developer";
    const { data: roleData, error: roleErr } = await client.rpc("my_workspace_role", {
      p_workspace_id: ws,
    });
    if (roleErr) {
      log.warn("[chat] cloud memory: role resolve failed, defaulting to developer:", roleErr);
    } else if (typeof roleData === "string" && roleData) {
      functionalRole = roleData;
    }
    const turnIdentity: TurnIdentity = {
      authorId,
      authorName: deriveAuthorName(
        userData.user.user_metadata as Record<string, unknown> | undefined,
        authorEmail,
        authorId,
      ),
      functionalRole,
    };

    // Semantic recall: recall older messages by meaning beyond the
    // lastMessages window, via the cloud SupabaseVector (pgvector). Always on now —
    // embeddings are local fastembed (free), so the old per-message API cost that
    // gated this is gone. Cloud vectors are workspace-scoped by RLS; filter by thread.
    const embedder = resolveSemanticRecallEmbedder();
    // Observational memory: Observer/Reflector background agents maintain a
    // dense observation log as long context grows. Routed through the proxy in prod
    // (free memory-op) or a direct gateway key in dev. Runs an extra LLM call per
    // turn, absorbed as free internal infra.
    const observerModel = resolveObserverModel(proxyConfig);
    // Auto-title threads: reuse the observer model when present (gateway in
    // dev, proxy in prod — no bare-provider fallback). undefined → Mastra
    // skips auto-titling, which is acceptable degradation.
    const titleModel = observerModel;
    // One composite store instance, shared by Memory (below) AND the Harness
    // `storage` so both persist threads/messages to the same place.
    const storage = createSupabaseMemoryStore(ctx);
    const memory = new Memory({
      storage,
      vector: new SupabaseVector(ctx),
      embedder,
      options: {
        lastMessages: 20,
        semanticRecall: { topK: 5, messageRange: { before: 2, after: 1 } },
        // Shared team threads: working memory is per-THREAD (the adapter persists
        // it in the thread's metadata via mastra_update_thread — it implements no
        // resource-scoped store, so 'thread' is the correct + only viable scope).
        // The participants template tells the model how to read the <turn> tags
        // and gives it a slot to track who's in the conversation.
        workingMemory: {
          enabled: true,
          scope: "thread",
          template: TEAM_PARTICIPANTS_TEMPLATE,
        },
        ...(observerModel
          ? { observationalMemory: { model: observerModel, scope: "thread" as const } }
          : {}),
        // Auto-generated thread titles — power the future conversation list.
        ...(titleModel
          ? { generateTitle: { model: titleModel, instructions: TITLE_INSTRUCTIONS } }
          : {}),
      },
    });
    return { memory, storage, resourceId, client, turnIdentity };
  } catch (err) {
    log.warn("[chat] cloud memory setup failed, continuing without it:", err);
    return undefined;
  }
}

export function registerChatHandlers(): void {
  ipcMain.handle(
    "chat:start",
    async (
      event,
      payload: {
        text: string;
        chatId: string;
        model?: string;
        accessToken?: string;
        workspaceId?: string;
      },
    ) => {
      const wc = event.sender;
      const send = (channel: string, data: unknown): void => {
        if (!wc.isDestroyed()) wc.send(channel, data);
      };

      // Prod inference proxy: when NOT in dev-bypass AND the renderer supplied a
      // Supabase access token AND PROXY_BASE_URL is set, route generation through the
      // Supabase edge function (it holds the gateway key + meters usage). Otherwise the
      // direct Anthropic key is used (dev/owner). Triple-gated so dev testing is never affected.
      //
      // __DEV_BYPASS__ is the Vite-injected build-time literal (electron.vite.config.ts)
      // — `true` only in `electron-vite dev|preview` with FIVEM_STUDIO_DEV=1 in .env,
      // `false` in every packaged build. Same literal used in main/index.ts; both must
      // agree or the bypass logic forks.
      const DEV_BYPASS = __DEV_BYPASS__;
      const proxyBase = process.env.PROXY_BASE_URL;
      const proxyConfig =
        !DEV_BYPASS && payload.accessToken && proxyBase
          ? {
              url: proxyBase,
              token: payload.accessToken,
              anonKey: process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY,
            }
          : undefined;

      // Dev/owner needs the Vercel AI Gateway key (one provider-agnostic path —
      // no bare-Anthropic fallback). OPENAI_BASE_URL also counts (local
      // OpenAI-compatible endpoint / AIMock). Prod routes through the proxy.
      const hasDevKey =
        process.env.VERCEL_GATEWAY_KEY ||
        process.env.AI_GATEWAY_API_KEY ||
        process.env.OPENAI_BASE_URL;
      if (!proxyConfig && !hasDevKey) {
        send(
          "chat:error",
          "No inference key — set VERCEL_GATEWAY_KEY for local dev (free monthly credits at vercel.com/ai-gateway), or sign in.",
        );
        return;
      }
      const settings = await readSettings();
      const server = getActiveServer(settings);
      if (!server?.localPath) {
        send("chat:error", "No active server configured. Configure your server path.");
        return;
      }

      const resourcesRoot = dirname(server.localPath);
      // Normalize the renderer's model id to a Mastra provider string. The UI
      // sends a bare Claude id (e.g. "claude-opus-4-6"); prefix the provider when
      // absent. Falls through to MASTRA_MODEL/default in the agent when undefined.
      const model = payload.model
        ? payload.model.includes("/")
          ? payload.model
          : `anthropic/${payload.model}`
        : undefined;
      // ox RAG knowledge for this turn, resolved CONCURRENTLY with cloud memory
      // on a shared authenticated Supabase client (cloud match_ox_corpus RPC,
      // no direct DB credential). Reassigned below.
      let ragContext: string[] = [];
      // The distinct ox sources behind ragContext — forwarded to the Harness UI as
      // citations ("Grounded in N ox sources").
      let ragSources: OxSource[] = [];

      const abort = new AbortController();
      state.mastraAbort = abort;
      state.mastraThreadId = payload.chatId;

      // Track write_file tool calls so we can build a GenerationResult (file tree
      // + undo) for the right panel + snapshot-before-overwrite. The Harness path
      // feeds it by tapping `tool_start` write_file events (see forwardEvent).
      const tracker = createWriteTracker(server, resourcesRoot);

      // Durable per-tenant cloud chat memory. Resolved from the JWT; falls
      // back to undefined (→ the harness runs single-turn / no-cloud) when
      // cloud isn't configured/reachable. In dev-bypass there's no renderer JWT,
      // so sign in the seeded local dev user → SAME adapter path as prod.
      const accessToken =
        payload.accessToken ?? (__DEV_BYPASS__ ? await getDevAccessToken() : undefined);

      // Resolve cloud memory and query ox RAG CONCURRENTLY. RAG needs only the
      // authenticated client — ox_corpus is a shared, workspace-agnostic read — so
      // overlapping it with cloud memory's several sequential RPCs hides the RAG
      // round-trip under memory resolution instead of stacking on top of it (this is
      // the "RAG blocks the first token" latency). Both are fully fail-safe (memory →
      // undefined, RAG → []), so neither breaks generation and Promise.all never
      // rejects. The client is built once (cheap, no network) and shared by both;
      // RAG now also survives a partial cloud-memory failure since it no longer
      // depends on the full resolution — just the client.
      const runClient = accessToken ? createRunClient(accessToken) : undefined;
      const [cloud, rag] = await Promise.all([
        resolveCloudMemory(
          accessToken,
          payload.workspaceId,
          server.serverPath,
          proxyConfig,
          runClient,
        ),
        queryOxContext(payload.text, runClient),
      ]);
      ragContext = rag.context;
      ragSources = rag.sources;

      // Shared team threads: prepend a <turn> attribution tag built from the
      // AUTHENTICATED identity (auth.uid()/name + workspace role) so each message in
      // a shared workspace+server thread is correctly attributed to its sender. Only
      // when cloud memory is active; the raw text (untagged) is what RAG embeds above.
      const chatPrompt = cloud ? tagUserMessage(payload.text, cloud.turnIdentity) : payload.text;

      // Keep the system awake for the duration of the generation.
      const releaseAwake = keepAwake("generation");
      try {
        // Effective RCON password: Settings override, else server.cfg + the files
        // it exec's (the password is usually in a gitignored secrets cfg). Without
        // this, deploy/install reported "RCON isn't configured".
        const rconPassword = await resolveServerRconPassword(
          server,
          state.cachedContext?.serverCfgPath,
        );

        // Generation runs EXCLUSIVELY through the Mastra Harness (supervisor +
        // isolated specialist subagents + HITL). The legacy single-agent
        // runChatStream path (agent.stream + manual approval loop, chat:chunk
        // transport) has been removed. Generated files reach the ArtifactPanel
        // via finalizeGeneration, fed by tapping `tool_start` write_file events;
        // the SAME `abort` controller means chat:cancel cancels this too.
        {
          const skillPaths = oxSkillPaths(
            join(app.isPackaged ? `${app.getAppPath()}.unpacked` : app.getAppPath(), "skills"),
          );
          // The harness event sink: tap write_file for the artifact manifest,
          // then forward to the renderer's harness hook. Captured by state.harnessResume
          // so a later respondSuspension keeps writing to the SAME tracker.
          const forwardEvent = (e: HarnessWireEvent): void => {
            if (e.type === "tool_start" && e.toolName === WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE) {
              const path = (e.args as { path?: string } | undefined)?.path;
              if (typeof path === "string") tracker.trackPath(path);
            }
            send("harness:event", e);
          };
          // Finalize once the turn actually COMPLETES (immediately, or after an
          // ask_user resume): assemble the manifest/result/log (→ ArtifactPanel +
          // undo, via chat:result) and tear the persistent runtime down.
          const completeTurn = async (runtime: HarnessRuntime): Promise<void> => {
            try {
              const { generationId, resourceName } = await finalizeGeneration({
                server,
                resourcesRoot,
                writtenAbs: tracker.writtenAbs,
                backupPath: tracker.backupPath,
                serverCfgPath: state.cachedContext?.serverCfgPath,
                prompt: payload.text,
                model,
                ragContext,
                threadId: payload.chatId,
                send,
              });
              // Forward the logged generation id so the Harness chat can attach
              // thumbs-up/down feedback to this exact turn (parity with AEChat).
              if (generationId) forwardEvent({ type: "generation_logged", generationId });
              notify(
                "myRP.build",
                resourceName ? `Resource "${resourceName}" generated` : "Generation complete",
                { onlyWhenUnfocused: true },
              );
            } finally {
              state.harnessResume = null;
              state.harnessSession = null;
              if (state.harnessRuntime === runtime) state.harnessRuntime = null;
              await disposeHarnessRuntime(runtime).catch(() => {});
            }
          };
          try {
            // A new user message abandons any unanswered ask_user from a prior turn.
            if (state.harnessRuntime) {
              const stale = state.harnessRuntime;
              state.harnessRuntime = null;
              state.harnessResume = null;
              await disposeHarnessRuntime(stale).catch(() => {});
            }
            // Build a fresh runtime per turn (keeps RAG/model current); the session
            // stays alive only when the turn PARKS, so ask_user can resume it.
            const runtime = await buildHarnessRuntime(resourcesRoot, {
              key: `${cloud?.resourceId ?? "local"}:${resourcesRoot}`,
              model,
              proxyConfig,
              ...(cloud
                ? { memory: cloud.memory, resourceId: cloud.resourceId, storage: cloud.storage }
                : {}),
              ragContext,
              skillPaths,
              indexPaths: [server.localPath],
              requireApproval: settings.requireApproval ?? true,
              deployConfig: { port: server.serverPort ?? 30120, rconPassword },
              serverConfig: { port: server.serverPort ?? 30120 },
              installConfig: { resourcesRoot, port: server.serverPort ?? 30120, rconPassword },
              ...(state.cachedContext?.serverCfgPath
                ? {
                    importSchemaConfig: {
                      localPath: server.localPath,
                      serverCfgPath: state.cachedContext.serverCfgPath,
                    },
                  }
                : {}),
              // Mastra AI tracing: dev/owner only — ConsoleExporter, no cred.
              // Prod gets a persistent sink in a later pass (no-shipped-creds rule).
              ...(DEV_BYPASS ? { observability: createFiveMObservability() } : {}),
            });
            state.harnessRuntime = runtime;
            state.harnessSession = runtime.session;

            // Surface the ox docs that grounded this turn as UI citations.
            if (ragSources.length > 0) {
              forwardEvent({ type: "rag_sources", sources: ragSources });
            }

            const { suspended } = await sendHarnessTurn(runtime, {
              // Continue an existing thread, or "" / unknown → start fresh (the
              // Harness mints the id and reports it via __thread__).
              text: chatPrompt,
              threadId: payload.chatId || undefined,
              send: forwardEvent,
              signal: abort.signal,
            });

            if (suspended) {
              // Parked on ask_user: keep the runtime + tracker alive so the answer
              // (harness:respondSuspension) resumes the SAME session; finalize then.
              state.harnessResume = { send: forwardEvent, complete: () => completeTurn(runtime) };
            } else {
              await completeTurn(runtime);
            }
          } catch (err) {
            // buildHarnessRuntime throws only on the BUILD phase (workspace/Harness
            // init); turn errors are already forwarded as an `error` event. Emit a
            // final error + __done__ so the renderer hook always terminates.
            log.error("[chat] harness turn failed:", err);
            const msg = friendlyLlmError(err instanceof Error ? err.message : String(err));
            send("harness:event", { type: "error", error: msg });
            send("harness:event", { type: "__done__" });
            const rt = state.harnessRuntime;
            state.harnessRuntime = null;
            state.harnessResume = null;
            state.harnessSession = null;
            if (rt) await disposeHarnessRuntime(rt).catch(() => {});
          }
          return; // outer finally still runs (releaseAwake + mastraAbort cleanup)
        }
      } catch (err) {
        log.error("[chat] stream failed:", err);
        send("chat:error", friendlyLlmError(err instanceof Error ? err.message : String(err)));
        notify("myRP.build", "Generation failed", { onlyWhenUnfocused: true });
      } finally {
        if (state.mastraAbort === abort) state.mastraAbort = null;
        releaseAwake();
      }
    },
  );

  ipcMain.handle("chat:cancel", async () => {
    state.mastraAbort?.abort();
    // A cancel during a pending approval should decline so the run unwinds.
    state.pendingApproval?.(false);
    state.pendingApproval = null;
    // Harness path: a cancel while PARKED on ask_user has no active run to abort
    // (the turn already returned). Drop the pending suspension, tell the renderer
    // (__done__ clears the card), and tear the persistent runtime down.
    const pending = state.harnessResume;
    const runtime = state.harnessRuntime;
    if (pending && runtime) {
      state.harnessResume = null;
      state.harnessRuntime = null;
      state.harnessSession = null;
      pending.send({ type: "__done__" });
      await disposeHarnessRuntime(runtime).catch(() => {});
    }
  });

  ipcMain.handle("chat:approve", (_event, approved: boolean) => {
    const resolve = state.pendingApproval;
    state.pendingApproval = null;
    resolve?.(approved);
  });

  // The Harness is the ONLY generation path now; the renderer always drives the
  // harness hook/channel (harness:event). Retained so the renderer's one-time
  // probe resolves without special-casing; removed when the renderer drops the
  // last isEnabled() call.
  ipcMain.handle("harness:isEnabled", () => true);

  // Harness path approval (the policy layer owns the category policy): answer the parked
  // tool-approval gate on the live session. No-op when nothing is awaiting
  // approval. "always_allow_category" grants the gated tool's category for the
  // rest of the session (resolved via the Harness toolCategoryResolver).
  ipcMain.handle(
    "harness:approve",
    (
      _event,
      payload: { decision: "approve" | "decline" | "always_allow_category"; toolCallId?: string },
    ) => {
      state.harnessSession?.respondToToolApproval({
        decision: payload.decision,
        ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
      });
    },
  );

  // Harness path ask_user resume: answer a parked tool suspension on the
  // live session. respondToToolSuspension drives a fresh run on the SAME session
  // (the reason the runtime is kept alive when a turn parks). When that run
  // completes, finalize the turn (artifact manifest); if it parks again, keep
  // waiting for the next answer. No-op when nothing is suspended.
  ipcMain.handle(
    "harness:respondSuspension",
    async (_event, payload: { answer: unknown; toolCallId?: string }) => {
      const runtime = state.harnessRuntime;
      const pending = state.harnessResume;
      if (!runtime || !pending) return;
      const abort = new AbortController();
      state.mastraAbort = abort;
      const releaseAwake = keepAwake("generation");
      try {
        const { suspended } = await resumeHarnessSuspension(runtime, {
          resumeData: payload.answer,
          ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
          send: pending.send,
          signal: abort.signal,
        });
        if (!suspended) {
          state.harnessResume = null;
          await pending.complete();
        }
        // Parked again → keep state.harnessResume for the next answer.
      } catch (err) {
        log.error("[chat] harness resume failed:", err);
        const msg = friendlyLlmError(err instanceof Error ? err.message : String(err));
        pending.send({ type: "error", error: msg });
        pending.send({ type: "__done__" });
        const rt = state.harnessRuntime;
        state.harnessResume = null;
        state.harnessRuntime = null;
        state.harnessSession = null;
        if (rt) await disposeHarnessRuntime(rt).catch(() => {});
      } finally {
        if (state.mastraAbort === abort) state.mastraAbort = null;
        releaseAwake();
      }
    },
  );

  // Clone a conversation: branch a thread via Mastra's native
  // Memory.cloneThread(), which delegates to SupabaseMemoryStorage.cloneThread().
  // The clone inherits the source's resourceId so
  // workspace/server scoping is preserved, and gets Mastra's standard clone
  // metadata ({ sourceThreadId, clonedAt, lastMessageId }). Same adapter the chat
  // uses (cloud in prod, local-Supabase via the seeded dev JWT in dev, v1f9).
  ipcMain.handle(
    "chat:clone",
    async (
      _event,
      payload: {
        sourceThreadId: string;
        newThreadId: string;
        accessToken?: string;
        workspaceId?: string;
      },
    ): Promise<{ ok: boolean; copied?: number; error?: string }> => {
      try {
        const server = getActiveServer(await readSettings());
        const accessToken =
          payload.accessToken ?? (__DEV_BYPASS__ ? await getDevAccessToken() : undefined);
        const cloud = await resolveCloudMemory(
          accessToken,
          payload.workspaceId,
          server?.serverPath,
        );
        if (!cloud) {
          return { ok: false, error: "No chat memory is configured to clone from." };
        }
        const memory = cloud.memory;
        if (!(await memory.getThreadById({ threadId: payload.sourceThreadId }))) {
          return { ok: false, error: "This conversation isn't persisted yet — nothing to clone." };
        }
        const { clonedMessages } = await memory.cloneThread({
          sourceThreadId: payload.sourceThreadId,
          newThreadId: payload.newThreadId,
        });
        return { ok: true, copied: clonedMessages.length };
      } catch (err) {
        log.warn("[chat] clone failed:", err);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // Feedback capture: renderer attaches a thumbs up/down to a logged
  // generation. Fail-safe — returns false if logging is unconfigured/unreachable.
  ipcMain.handle(
    "feedback:rate",
    (_event, payload: { generationId: string; rating: "up" | "down" }) =>
      rateGeneration(payload.generationId, payload.rating),
  );
}
