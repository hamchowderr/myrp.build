/**
 * IPC for the AI-Elements chat path (fivem-studio-k8v). Bridges the renderer's
 * custom AI SDK ChatTransport to a main-process agent.stream():
 *
 *   renderer transport --chat:start--> here --runChatStream--> agent.stream()
 *      --toAISdkStream(v6)--> webContents.send("chat:chunk") --> transport
 *      reassembles a ReadableStream<UIMessageChunk> --> useChat + AI Elements.
 *
 * Per-turn we send only the new user message; the Mastra memory thread (= the
 * useChat chatId) carries prior context server-side.
 */

import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { Memory } from "@mastra/memory";
import { createGateway } from "ai";
import { app, ipcMain } from "electron";
import log from "electron-log/main";
import { getActiveServer } from "../../renderer/src/lib/server-registry";
import { resolveServerRconPassword } from "../context";
import { appendEnsureLine, backupResourceSync, writeGenerationManifest } from "../fileWriter";
import { logGeneration, rateGeneration } from "../generation-log";
import { runChatStream } from "../mastra/chat";
import { EMBEDDER } from "../mastra/embedder";
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
import { queryOxContext } from "../rag";
import { readSettings, state } from "../shared-state";
import { scheduleAutoBackup } from "./backup";

const LOCAL_DIR = "[local]";

/** Cheap, fast model for the OM Observer + Reflector background agents. */
const OBSERVER_MODEL_ID = "anthropic/claude-haiku-4-5";

/** Instructions for Mastra's generateTitle — auto-names each thread so a future
 *  conversation list/search is legible (eh2g). 3-6 words, plain text, ox-flavored. */
const TITLE_INSTRUCTIONS =
  "Generate a concise 3-6 word title summarizing this conversation from the user's first message. " +
  "Plain text only — no markdown, no surrounding quotes, no trailing punctuation. " +
  "Name the FiveM resource or task (e.g. 'Car dealership with test drives', 'Police MDT warrant lookup').";

/** Prod inference-proxy config (mirrors the agent's): the edge fn URL + the user's
 *  Supabase token as the gateway key + the anon key for Kong. */
type ProxyCfg = { url: string; token: string; anonKey?: string };

/** Headers for a memory-op gateway call routed through the proxy: mark it free
 *  (x-myrp-memory-op) so the proxy skips quota + metering (z8j8.5), + Kong's apikey. */
function memoryProxyHeaders(proxy: ProxyCfg): Record<string, string> {
  return { "x-myrp-memory-op": "1", ...(proxy.anonKey ? { apikey: proxy.anonKey } : {}) };
}

/**
 * The semantic-recall embedder: local fastembed (bge-small-en-v1.5, 384-dim) via
 * the shared {@link EMBEDDER} — CPU-only, free, no API key, nothing leaves the
 * machine. Always available (no proxy/key gate), so semantic recall is now always
 * on: the per-message API cost that kept it disabled is gone (1n47). Same model as
 * rag.ts / the ox_corpus index — the SupabaseVector table is sized to match (384).
 */
function resolveSemanticRecallEmbedder() {
  return EMBEDDER;
}

/**
 * Build the OM observer/reflector model, or undefined when no model path exists.
 * PROD: route through the inference proxy (free memory-op, no quota/metering). DEV/owner:
 * direct Vercel AI Gateway (VERCEL_GATEWAY_KEY). Runs an extra LLM call per turn,
 * absorbed as free internal infra (owner decision, z8j8.5).
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
 * routing exactly like the agent + generateTitle: the prod inference proxy (free memory-op,
 * no quota/metering) when not in dev-bypass and a token + PROXY_BASE_URL are present, else a
 * direct gateway key, else the bare Anthropic id via ANTHROPIC_API_KEY. Returns undefined when
 * no inference path exists (→ caller silently shows no suggestions). The bare string id is
 * resolved by Mastra's model router, same as the agent's dev-bypass model.
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
  return (
    resolveObserverModel(proxyConfig) ??
    (process.env.ANTHROPIC_API_KEY ? OBSERVER_MODEL_ID : undefined)
  );
}

/** "[local]/heal-command/server/main.lua" -> "heal-command". */
function resourceNameFromRel(rel: string): string | undefined {
  const parts = rel.replace(/\\/g, "/").split("/").filter(Boolean);
  const i = parts.indexOf(LOCAL_DIR);
  if (i >= 0 && parts.length > i + 1) return parts[i + 1];
  return parts.length > 1 ? parts[0] : undefined;
}

/** Map raw upstream LLM provider errors to a clear, actionable chat message. */
function friendlyLlmError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("credit balance is too low") || s.includes("billing"))
    return "Anthropic API: out of credits. Add credits (or point ANTHROPIC_API_KEY at a funded account) and try again.";
  if (s.includes("invalid x-api-key") || s.includes("authentication") || s.includes("401"))
    return "Anthropic API: invalid or missing API key. Check ANTHROPIC_API_KEY.";
  if (s.includes("rate limit") || s.includes("429") || s.includes("overloaded"))
    return "Anthropic API: rate limited or overloaded. Wait a moment and try again.";
  return `Generation failed: ${raw}`;
}

/** Resolved cloud-memory context for a chat run. */
export interface CloudMemory {
  memory: Memory;
  resourceId: string;
  /** The run's authenticated Supabase client (anon key + JWT) — reused for the
   *  RAG read RPC (M3.3) so a single client serves memory + corpus retrieval. */
  client: RunStorageContext["client"];
  /** Authenticated identity for the <turn> attribution tag (M3.2). Built from
   *  auth.uid()/email + the member's workspace role — never from a client arg. */
  turnIdentity: TurnIdentity;
}

/**
 * Resolve durable per-tenant cloud chat memory for this run (M2.4).
 *
 * Builds a Supabase run client from the user's JWT (anon key + Bearer JWT — no DB
 * credential), resolves the authenticated identity via auth.getUser() and the
 * active workspace (explicit `workspaceId`, else the personal workspace via
 * rpc('get_subscription')), then returns a cloud Memory backed by
 * SupabaseMemoryStorage. For M2 the scope is the personal workspace with a null
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
): Promise<CloudMemory | undefined> {
  if (!accessToken) return undefined;
  try {
    const client = createRunClient(accessToken);
    if (!client) return undefined; // url/anon key not configured (e.g. M3.4 pending)

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

    // Resolve (or create) the server row for this client's configured server
    // (M3.1). serverId scopes the resourceId so a team's chat memory is SHARED
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

    // Resolve the member's role in the active workspace for the <turn> tag (M3.2)
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

    // Semantic recall (z8j8.4 / 1n47): recall older messages by meaning beyond the
    // lastMessages window, via the cloud SupabaseVector (pgvector). Always on now —
    // embeddings are local fastembed (free), so the old per-message API cost that
    // gated this is gone. Cloud vectors are workspace-scoped by RLS; filter by thread.
    const embedder = resolveSemanticRecallEmbedder();
    // Observational memory (z8j8.3): Observer/Reflector background agents maintain a
    // dense observation log as long context grows. Routed through the proxy in prod
    // (free memory-op) or a direct gateway key in dev. Runs an extra LLM call per
    // turn, absorbed as free internal infra (z8j8.5).
    const observerModel = resolveObserverModel(proxyConfig);
    // Auto-title threads (eh2g): reuse the observer model when present; in
    // dev-bypass with only ANTHROPIC_API_KEY, fall back to the bare model id
    // (Mastra resolves it via the key, exactly as the agent's model does).
    const titleModel =
      observerModel ?? (process.env.ANTHROPIC_API_KEY ? OBSERVER_MODEL_ID : undefined);
    const memory = new Memory({
      storage: createSupabaseMemoryStore(ctx),
      vector: new SupabaseVector(ctx),
      embedder,
      options: {
        lastMessages: 20,
        semanticRecall: { topK: 5, messageRange: { before: 2, after: 1 } },
        // Shared team threads: working memory is per-THREAD (the adapter persists
        // it in the thread's metadata via mastra_update_thread — it implements no
        // resource-scoped store, so 'thread' is the correct + only viable scope).
        // The participants template tells the model how to read the <turn> tags
        // and gives it a slot to track who's in the conversation (M3.2).
        workingMemory: {
          enabled: true,
          scope: "thread",
          template: TEAM_PARTICIPANTS_TEMPLATE,
        },
        ...(observerModel
          ? { observationalMemory: { model: observerModel, scope: "thread" as const } }
          : {}),
        // Auto-generated thread titles (eh2g) — power the future conversation list.
        ...(titleModel
          ? { generateTitle: { model: titleModel, instructions: TITLE_INSTRUCTIONS } }
          : {}),
      },
    });
    return { memory, resourceId, client, turnIdentity };
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

      // Prod inference proxy (ok7): when NOT in dev-bypass AND the renderer supplied a
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

      // Dev/owner needs a usable key: a gateway key (any model) or ANTHROPIC_API_KEY
      // (Anthropic-only fallback). Prod routes through the proxy (proxyConfig).
      const hasDevKey =
        process.env.VERCEL_GATEWAY_KEY ||
        process.env.AI_GATEWAY_API_KEY ||
        process.env.ANTHROPIC_API_KEY;
      if (!proxyConfig && !hasDevKey) {
        send(
          "chat:error",
          "No API key — set VERCEL_GATEWAY_KEY (any model) or ANTHROPIC_API_KEY for local dev, or sign in.",
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
      // ox RAG knowledge for this turn is queried AFTER cloud memory resolves,
      // so it can reuse the run's authenticated Supabase client for the cloud
      // match_ox_corpus RPC (M3.3 — no direct DB credential). Reassigned below.
      let ragContext: string[] = [];

      const abort = new AbortController();
      state.mastraAbort = abort;
      state.mastraThreadId = payload.chatId;

      // Track write_file tool calls so we can build a GenerationResult (file
      // tree + undo) for the right panel — mirrors runGeneration's tracking.
      const writtenAbs = new Set<string>();
      // Auto-backup-before-overwrite state (fivem-studio-80v): the resource dirs
      // already snapshotted this turn, and the snapshot path to record in the
      // manifest so undo can restore the pre-overwrite original.
      const backedUp = new Set<string>();
      let backupPath: string | undefined;
      const trackWrite = (chunk: unknown): void => {
        const c = chunk as {
          type?: string;
          toolName?: string;
          input?: { path?: string };
        };
        if (
          c.type === "tool-input-available" &&
          c.toolName === WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE &&
          typeof c.input?.path === "string"
        ) {
          writtenAbs.add(join(resourcesRoot, c.input.path));
          // The FIRST time this turn writes into a resource that already exists
          // on disk, synchronously snapshot it BEFORE the write executes so a
          // regeneration is reversible (undo restores the original). Sync +
          // fired on tool-input-available => race-free; non-fatal. (80v)
          const resName = resourceNameFromRel(c.input.path);
          if (resName) {
            const resourceDir = join(server.localPath, resName);
            if (!backedUp.has(resourceDir)) {
              backedUp.add(resourceDir);
              const snapped = backupResourceSync(resourceDir, server.localPath);
              if (snapped) backupPath = snapped;
            }
          }
        }
      };

      // Durable per-tenant cloud chat memory (M2.4). Resolved from the JWT; falls
      // back to undefined (→ runChatStream uses the local/no-cloud path) when
      // cloud isn't configured/reachable. In dev-bypass there's no renderer JWT,
      // so sign in the seeded local dev user → SAME adapter path as prod (v1f9).
      const accessToken =
        payload.accessToken ?? (__DEV_BYPASS__ ? await getDevAccessToken() : undefined);
      const cloud = await resolveCloudMemory(
        accessToken,
        payload.workspaceId,
        server.serverPath,
        proxyConfig,
      );

      // ox RAG knowledge for this turn (fail-safe to none). Cut over to the cloud
      // match_ox_corpus RPC (M3.3): retrieval reuses the run's authenticated
      // Supabase client (anon key + JWT) — no direct RAG_DATABASE_URL connection.
      // Without a signed-in client (dev-bypass / no cloud) RAG silently no-ops.
      try {
        ragContext = await queryOxContext(payload.text, cloud?.client);
        if (ragContext.length > 0) {
          log.info(`[chat] RAG returned ${ragContext.length} ox snippets`);
        }
      } catch (err) {
        log.warn("[chat] RAG query failed, continuing without it:", err);
      }

      // Shared team threads (M3.2): prepend a <turn> attribution tag built from the
      // AUTHENTICATED identity (auth.uid()/name + workspace role) so each message in
      // a shared workspace+server thread is correctly attributed to its sender. Only
      // when cloud memory is active; the raw text (untagged) is what RAG embeds above.
      const chatPrompt = cloud ? tagUserMessage(payload.text, cloud.turnIdentity) : payload.text;

      // Keep the system awake for the duration of the generation (fivem-studio-1gi).
      const releaseAwake = keepAwake("generation");
      try {
        // Effective RCON password: Settings override, else server.cfg + the files
        // it exec's (the password is usually in a gitignored secrets cfg). Without
        // this, deploy/install reported "RCON isn't configured" (fivem-studio-92fh).
        const rconPassword = await resolveServerRconPassword(
          server,
          state.cachedContext?.serverCfgPath,
        );
        await runChatStream(chatPrompt, resourcesRoot, {
          threadId: payload.chatId,
          model,
          proxyConfig,
          ...(cloud ? { memory: cloud.memory, resourceId: cloud.resourceId } : {}),
          ragContext,
          skillPaths: oxSkillPaths(join(app.getAppPath(), "skills")),
          indexPaths: [server.localPath],
          // Approval-gated deploy_resource (445.2): ensure built resources on the
          // running server via RCON. Always pauses for approval; no-ops if offline.
          deployConfig: {
            port: server.serverPort ?? 30120,
            rconPassword,
          },
          // Approval-gated server lifecycle (fivem-studio-w2s): the agent can
          // start/stop/restart the local FXServer (each pauses for approval) and
          // check status (read-only). Amends the 2026-05-23 contract.
          serverConfig: {
            port: server.serverPort ?? 30120,
          },
          // Approval-gated install_resource (fivem-studio-8m1): install a missing ox
          // dependency (download release -> resources/[ox] -> ensure).
          installConfig: {
            resourcesRoot,
            port: server.serverPort ?? 30120,
            rconPassword,
          },
          // Approval-gated import_schema (fivem-studio-h5k): run a resource's
          // sql/install.sql against the server DB (connection string read from
          // server.cfg) so the agent finishes setup instead of telling the user
          // to import by hand. Only when we know where server.cfg is.
          ...(state.cachedContext?.serverCfgPath
            ? {
                importSchemaConfig: {
                  localPath: server.localPath,
                  serverCfgPath: state.cachedContext.serverCfgPath,
                },
              }
            : {}),
          abortSignal: abort.signal,
          requireApproval: settings.requireApproval ?? false,
          // Surface the pause to the renderer (the tool part already streamed
          // shows "Awaiting Approval") and wait for chat:approve to resolve.
          awaitApproval: (runId) =>
            new Promise<boolean>((resolve) => {
              state.pendingApproval = resolve;
              send("chat:approval_pending", { runId });
            }),
          onChunk: (chunk) => {
            trackWrite(chunk);
            send("chat:chunk", chunk);
          },
        });
        // Assemble a result (manifest + file list) so the renderer can refresh
        // the file tree and offer Undo.
        const paths = [...writtenAbs];
        let resourceName: string | undefined;
        if (paths.length > 0) {
          const firstRel = paths[0].slice(resourcesRoot.length + 1);
          resourceName = resourceNameFromRel(firstRel) ?? "resource";
          try {
            const result = await writeGenerationManifest(
              server.localPath,
              resourceName,
              paths,
              backupPath,
            );
            send("chat:result", result);
          } catch (err) {
            log.warn("[chat] manifest write failed:", err);
          }
          // Auto-ensure (fivem-studio-47q): persist `ensure <resource>` to
          // server.cfg so a freshly-generated resource also starts on the next
          // server boot — not just the runtime RCON ensure the deploy step does.
          // Idempotent (skips if already present) + non-fatal; only when we know
          // where server.cfg is.
          const cfgPath = state.cachedContext?.serverCfgPath;
          if (cfgPath) await appendEnsureLine(cfgPath, resourceName);
          // Optional auto-backup (dbjw): files changed, so schedule a debounced
          // commit+push of the active server. No-op unless settings.autoBackup is
          // on AND GitHub is connected + a repo linked; failures never interrupt.
          scheduleAutoBackup();
        }
        // Capture this generation for the feedback/fine-tune dataset (zhk.9).
        // Fail-safe inside logGeneration — never blocks completion. The id lets
        // the renderer attach a thumbs up/down to this exact generation.
        const generationId = await logGeneration({
          prompt: payload.text,
          model: model ?? process.env.MASTRA_MODEL ?? "anthropic/claude-sonnet-4-6",
          ragUsed: ragContext.length > 0,
          ragChunkCount: ragContext.length,
          resourceName,
          outputFiles: paths.map((p) => p.slice(resourcesRoot.length + 1)),
          threadId: payload.chatId,
        });
        send("chat:done", { generationId });
        notify(
          "myRP.build",
          resourceName ? `Resource "${resourceName}" generated` : "Generation complete",
          { onlyWhenUnfocused: true },
        );
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

  ipcMain.handle("chat:cancel", () => {
    state.mastraAbort?.abort();
    // A cancel during a pending approval should decline so the run unwinds.
    state.pendingApproval?.(false);
    state.pendingApproval = null;
  });

  ipcMain.handle("chat:approve", (_event, approved: boolean) => {
    const resolve = state.pendingApproval;
    state.pendingApproval = null;
    resolve?.(approved);
  });

  // Clone a conversation (dnx8.2): branch a thread via Mastra's native
  // Memory.cloneThread(), which delegates to SupabaseMemoryStorage.cloneThread()
  // (fivem-studio-liza). The clone inherits the source's resourceId so
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

  // Feedback capture (zhk.9): renderer attaches a thumbs up/down to a logged
  // generation. Fail-safe — returns false if logging is unconfigured/unreachable.
  ipcMain.handle(
    "feedback:rate",
    (_event, payload: { generationId: string; rating: "up" | "down" }) =>
      rateGeneration(payload.generationId, payload.rating),
  );
}
