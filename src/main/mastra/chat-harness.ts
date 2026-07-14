/**
 * Live Harness chat orchestration — the transport-agnostic
 * core of the Harness chat path, ported from mastra-chat-kit's POST
 * /harness/stream route. The main process wires `send` to IPC
 * (webContents.send) and the renderer folds the events via reduceHarnessEvent
 * (src/renderer/src/lib/harness/events.ts).
 *
 * Two layers:
 *  - {@link runHarnessTurn} drives ONE turn on an already-built Harness: bind the
 *    thread, subscribe, run, forward events. Pure transport — no lifecycle.
 *  - {@link runHarnessChat} owns the per-turn LIFECYCLE (build workspace + Harness,
 *    init, run, tear down), the Harness analogue of runChatStream(). This is what
 *    ipc/chat.ts calls behind the default-OFF useHarness flag, replacing
 *    createFiveMAgent + the manual `new Mastra({storage})` approval wrap.
 *
 * Both are exercised by AIMock tests with no IPC or Electron.
 */
import type { Session } from "@mastra/core/agent-controller";
import type { Harness } from "@mastra/core/harness";
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { createFiveMHarness, type FiveMHarnessOptions } from "./harness";
import { applyFiveMPermissions } from "./permissions";
import { createAndInitWorkspace } from "./workspace";

/** A serialized Harness event (or a transport sentinel) sent to the renderer. */
export type HarnessWireEvent = { type: string; [k: string]: unknown };

export interface HarnessTurnOptions {
  /** The user's new message (memory carries prior turns on the thread). */
  text: string;
  /** Continue an existing thread, or omit to start a new "Chat" thread. */
  threadId?: string;
  /** Memory/owner scope (ws_<ws>__srv_<srv> in prod; a local id in dev). */
  resourceId: string;
  /** Forward one event to the client (→ IPC in main; collected in tests). */
  send: (event: HarnessWireEvent) => void;
  /**
   * Hand the live session to the caller as soon as it exists, so the IPC layer
   * can reach it for tool-approval responses and cancellation while the
   * turn is in flight. Called once, before the run starts.
   */
  onSession?: (session: Session) => void;
  /**
   * Configure the session before the run starts — e.g. apply the HITL permission
   * policy. Awaited after thread binding, before sendMessage.
   */
  prepareSession?: (session: Session) => void | Promise<void>;
  /** Cancel the in-flight run (wired to harness:cancel) — calls session.abort(). */
  signal?: AbortSignal;
}

/**
 * Drive one Harness turn and forward its events to `send`. Mirrors the kit's
 * route: bind the thread, subscribe (raw events), emit `__thread__`, run, then
 * `__done__`. Returns the active thread id so the caller can continue the
 * conversation. Errors are surfaced as an `error` event, never thrown, so the
 * stream always terminates cleanly with `__done__`.
 */
export async function runHarnessTurn(harness: Harness, opts: HarnessTurnOptions): Promise<string> {
  const session = await harness.createSession({ resourceId: opts.resourceId });
  opts.onSession?.(session);
  // Cancellation: harness:cancel aborts the active run (drops parked tool
  // suspensions + the approval gate so a paused run finalizes rather than hangs).
  const onAbort = (): void => session.abort();
  if (opts.signal) {
    if (opts.signal.aborted) session.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  // Bind the thread. The renderer never invents thread ids: switch() requires an
  // EXISTING thread and create() mints its own. So an explicit id that exists is
  // continued; anything else (no id, or an unknown id) starts a fresh thread and
  // reports its real id back via the return value + the __thread__ event.
  let threadId = opts.threadId;
  if (threadId && (await session.thread.getById({ threadId }))) {
    await session.thread.switch({ threadId });
  } else {
    threadId = (await session.thread.create({ title: "Chat" })).id;
  }

  // Configure the session (e.g. the HITL permission policy) before the run.
  await opts.prepareSession?.(session);

  const unsubscribe = session.subscribe((event) => opts.send(event as HarnessWireEvent));
  opts.send({ type: "__thread__", threadId });
  try {
    await session.sendMessage({ content: opts.text });
  } catch (err) {
    opts.send({ type: "error", error: err instanceof Error ? err.message : String(err) });
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    unsubscribe();
    opts.send({ type: "__done__" });
  }
  return threadId;
}

/** A self-contained local store for the no-cloud path (dev-bypass / no JWT):
 *  in-memory threads/messages + in-memory workflow snapshots. Single-turn — no
 *  durable persistence, mirroring runChatStream's degradation when memory is
 *  unresolved. */
function localCompositeStore(): MastraCompositeStore {
  return new MastraCompositeStore({
    id: "fivem-harness-local",
    domains: {
      memory: new InMemoryStore().stores.memory,
      workflows: new InMemoryStore().stores.workflows,
    },
  });
}

export interface RunHarnessChatOptions extends Omit<FiveMHarnessOptions, "storage"> {
  /** Conversation thread id (continue) — omit to start a fresh thread. */
  threadId?: string;
  /** Memory/owner scope; defaults to the single-user local id. */
  resourceId?: string;
  /**
   * Thread/message/state persistence: the cloud composite store resolved from the
   * per-run JWT (ipc/chat.ts). Omit → a local in-memory store (single-turn).
   */
  storage?: MastraCompositeStore;
  /** Gate sensitive workspace ops (execute/delete) — wired to the Settings toggle. */
  requireApproval?: boolean;
  /** Absolute ox skill-folder paths to expose. */
  skillPaths?: string[];
  /** Paths to auto-index for search (app passes [local] only). */
  indexPaths?: string[];
  /** Cancel the in-flight run (wired to harness:cancel). */
  abortSignal?: AbortSignal;
  /** Forward one Harness event to the renderer (→ webContents.send). */
  send: (event: HarnessWireEvent) => void;
  /** Capture the live session for approval/cancel while the turn runs. */
  onSession?: (session: Session) => void;
}

/**
 * Run one chat turn through the Harness, owning the per-turn lifecycle: build +
 * init the workspace and Harness, drive the turn ({@link runHarnessTurn}), then
 * tear down. The Harness analogue of runChatStream — same build-per-turn shape,
 * same workspace destroy in `finally`.
 *
 * @param prompt        the user's new message (memory carries prior turns)
 * @param resourcesRoot the server's resources/ directory (workspace basePath)
 * @returns the active thread id (for continuing the conversation)
 */
export async function runHarnessChat(
  prompt: string,
  resourcesRoot: string,
  opts: RunHarnessChatOptions,
): Promise<string> {
  const {
    threadId,
    resourceId,
    storage,
    requireApproval,
    skillPaths,
    indexPaths,
    abortSignal,
    send,
    onSession,
    ...agentOpts
  } = opts;

  const workspace = await createAndInitWorkspace(resourcesRoot, {
    requireApproval,
    skillPaths,
    indexPaths,
  });
  const harness = createFiveMHarness(workspace, {
    ...agentOpts,
    resourcesRoot,
    storage: storage ?? localCompositeStore(),
  });
  try {
    await harness.init();
    return await runHarnessTurn(harness, {
      text: prompt,
      threadId,
      resourceId: resourceId ?? "myrp-build-local",
      send,
      onSession,
      // Apply the FiveM HITL policy before the run: live-server/install/
      // schema ops always gate; shell + delete gate under the Settings toggle.
      prepareSession: (session) => applyFiveMPermissions(session, { requireApproval }),
      signal: abortSignal,
    });
  } finally {
    await harness.destroy().catch(() => {});
    await workspace.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Persistent per-conversation runtime.
//
// runHarnessChat (above) builds + destroys a workspace/Harness/session on EVERY
// turn. That's fine for a one-shot answer, but it breaks the native ask_user
// flow: an ask_user suspension RESOLVES sendMessage and is answered by a SEPARATE
// respondToToolSuspension that drives a fresh run — so the session (and its
// subscription) must OUTLIVE the turn. Per-turn rebuild also leaves an orphan
// auto-thread behind each message. These primitives keep ONE workspace/Harness/
// session alive for the whole conversation: build once, send/resume many turns on
// it, dispose only on new-session / thread-switch / window-close.
// ---------------------------------------------------------------------------

/** A live Harness kept alive across the turns of one conversation. */
export interface HarnessRuntime {
  readonly harness: Harness;
  readonly workspace: Awaited<ReturnType<typeof createAndInitWorkspace>>;
  readonly session: Session;
  readonly resourceId: string;
  /** Identity for reuse — a new conversation (different key) rebuilds. */
  readonly key: string;
  /** Point event forwarding at the current turn's sink (reset each turn). */
  setForward(fn: (event: HarnessWireEvent) => void): void;
  /** Tear down the persistent event subscription. */
  unsubscribe(): void;
}

export interface BuildHarnessRuntimeOptions extends Omit<FiveMHarnessOptions, "storage"> {
  /** Identity for reuse across turns (e.g. `${resourceId}:${resourcesRoot}`). */
  key: string;
  /** Memory/owner scope; defaults to the single-user local id. */
  resourceId?: string;
  /** Cloud composite store (prod) — omit → a local in-memory store (dev). */
  storage?: MastraCompositeStore;
  /** Gate sensitive workspace ops (execute/delete) — wired to the Settings toggle. */
  requireApproval?: boolean;
  /** Absolute ox skill-folder paths to expose. */
  skillPaths?: string[];
  /** Paths to auto-index for search (app passes [local] only). */
  indexPaths?: string[];
}

/**
 * Build + init a persistent Harness runtime and subscribe once. The HITL policy
 * (applyFiveMPermissions) is applied here — it's idempotent and persists to
 * session state, so once-at-build is correct for a reused session.
 */
export async function buildHarnessRuntime(
  resourcesRoot: string,
  opts: BuildHarnessRuntimeOptions,
): Promise<HarnessRuntime> {
  const { key, resourceId, storage, requireApproval, skillPaths, indexPaths, ...agentOpts } = opts;
  const workspace = await createAndInitWorkspace(resourcesRoot, {
    requireApproval,
    skillPaths,
    indexPaths,
  });
  const harness = createFiveMHarness(workspace, {
    ...agentOpts,
    resourcesRoot,
    storage: storage ?? localCompositeStore(),
  });
  await harness.init();
  const resolvedResourceId = resourceId ?? "myrp-build-local";
  const session = await harness.createSession({ resourceId: resolvedResourceId });
  await applyFiveMPermissions(session, { requireApproval });

  // The subscription is persistent; each turn re-points `forward` at its own sink
  // (the write-tracker tap + webContents.send) so events reach the renderer live.
  let forward: (event: HarnessWireEvent) => void = () => {};
  const unsubscribe = session.subscribe((event) => forward(event as HarnessWireEvent));

  return {
    harness,
    workspace,
    session,
    resourceId: resolvedResourceId,
    key,
    setForward: (fn) => {
      forward = fn;
    },
    unsubscribe,
  };
}

export interface HarnessTurnResult {
  /** The active thread id (for continuing the conversation). */
  threadId: string;
  /** True when the turn ended parked on a tool suspension (ask_user / submit_plan). */
  suspended: boolean;
}

/** Wire an abort signal to abort the session's active run for the current turn. */
function bindAbort(session: Session, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    session.abort();
    return () => {};
  }
  const onAbort = (): void => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Send one user turn on a persistent runtime. Binds the thread, forwards events,
 * runs, then emits `__suspended__` (parked on ask_user — keep the card, DON'T
 * finalize) or `__done__` (run completed). The session is NOT torn down.
 */
export async function sendHarnessTurn(
  runtime: HarnessRuntime,
  opts: {
    text: string;
    threadId?: string;
    send: (event: HarnessWireEvent) => void;
    signal?: AbortSignal;
  },
): Promise<HarnessTurnResult> {
  const { session } = runtime;
  runtime.setForward(opts.send);
  const releaseAbort = bindAbort(session, opts.signal);

  let threadId = opts.threadId;
  if (threadId && (await session.thread.getById({ threadId }))) {
    await session.thread.switch({ threadId });
  } else {
    threadId = (await session.thread.create({ title: "Chat" })).id;
  }
  opts.send({ type: "__thread__", threadId });

  let suspended = false;
  try {
    await session.sendMessage({ content: opts.text });
    suspended = session.suspensions.hasPending();
  } catch (err) {
    opts.send({ type: "error", error: err instanceof Error ? err.message : String(err) });
  } finally {
    releaseAbort();
    opts.send({ type: suspended ? "__suspended__" : "__done__" });
  }
  return { threadId: threadId as string, suspended };
}

/**
 * Answer a parked tool suspension (ask_user / submit_plan) on a persistent
 * runtime — drives the resumed run to completion (or another suspension) and
 * emits `__suspended__` / `__done__` the same way {@link sendHarnessTurn} does.
 */
export async function resumeHarnessSuspension(
  runtime: HarnessRuntime,
  opts: {
    resumeData: unknown;
    toolCallId?: string;
    send: (event: HarnessWireEvent) => void;
    signal?: AbortSignal;
  },
): Promise<{ suspended: boolean }> {
  const { session } = runtime;
  runtime.setForward(opts.send);
  const releaseAbort = bindAbort(session, opts.signal);

  let suspended = false;
  try {
    await session.respondToToolSuspension({
      resumeData: opts.resumeData,
      ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
    });
    suspended = session.suspensions.hasPending();
  } catch (err) {
    opts.send({ type: "error", error: err instanceof Error ? err.message : String(err) });
  } finally {
    releaseAbort();
    opts.send({ type: suspended ? "__suspended__" : "__done__" });
  }
  return { suspended };
}

/** Tear down a persistent runtime: drop the subscription, destroy Harness + workspace. */
export async function disposeHarnessRuntime(runtime: HarnessRuntime): Promise<void> {
  runtime.unsubscribe();
  await runtime.harness.destroy().catch(() => {});
  await runtime.workspace.destroy().catch(() => {});
}
