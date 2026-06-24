/**
 * Observational memory for the cloud adapter (z8j8.3) — parity with @mastra/pg
 * MemoryPG. The observe/buffer/reflect LOGIC lives in @mastra/memory; the storage
 * layer is mechanical CRUD on a single record. We persist the full
 * ObservationalMemoryRecord as a jsonb document (dates as ISO strings) and run the
 * swap/merge logic in JS, then write back via a shallow-merge patch RPC — so no
 * 36-column SQL and no DB credential ships (RLS reads + SECURITY DEFINER writes).
 *
 * SupabaseMemoryStorage extends this base, so these methods live off memory.ts
 * (file-size cap) while staying part of the same MemoryStorage subclass.
 */
import { randomUUID } from "node:crypto";
import type {
  CreateObservationalMemoryInput,
  CreateReflectionGenerationInput,
  ObservationalMemoryHistoryOptions,
  ObservationalMemoryRecord,
  SwapBufferedReflectionToActiveInput,
  SwapBufferedToActiveInput,
  SwapBufferedToActiveResult,
  UpdateActiveObservationsInput,
  UpdateBufferedObservationsInput,
  UpdateBufferedReflectionInput,
  UpdateObservationalMemoryConfigInput,
} from "@mastra/core/storage";
import { MemoryStorage } from "@mastra/core/storage";
import type { Json } from "../../../types/database";
import type { RunStorageContext } from "./context";

const OM_TABLE = "mastra_observational_memory";

type OMChunk = NonNullable<ObservationalMemoryRecord["bufferedObservationChunks"]>[number];

export abstract class SupabaseObservationalMemory extends MemoryStorage {
  protected readonly ctx: RunStorageContext;
  // Cloud OM is supported (parity); running the observer is a separate Memory-config step.
  override readonly supportsObservationalMemory = true;

  constructor(ctx: RunStorageContext) {
    super();
    this.ctx = ctx;
  }

  protected omKey(
    threadId: string | null | undefined,
    resourceId: string | null | undefined,
  ): string {
    return threadId ? `thread:${threadId}` : `resource:${resourceId}`;
  }

  /** Revive a stored jsonb document into the Mastra record shape (Date fields). */
  protected parseOM(doc: Record<string, unknown>): ObservationalMemoryRecord {
    const r = doc as Record<string, unknown> & ObservationalMemoryRecord;
    return {
      ...r,
      createdAt: r.createdAt ? new Date(r.createdAt as unknown as string) : new Date(),
      updatedAt: r.updatedAt ? new Date(r.updatedAt as unknown as string) : new Date(),
      lastObservedAt: r.lastObservedAt
        ? new Date(r.lastObservedAt as unknown as string)
        : undefined,
      lastBufferedAtTime: r.lastBufferedAtTime
        ? new Date(r.lastBufferedAtTime as unknown as string)
        : null,
    };
  }

  private async omUpsert(record: ObservationalMemoryRecord): Promise<void> {
    const { error } = await this.ctx.client.rpc("mastra_om_upsert", {
      p_workspace_id: this.ctx.workspaceId,
      p_id: record.id,
      p_lookup_key: this.omKey(record.threadId, record.resourceId),
      p_generation_count: record.generationCount,
      p_record: record as unknown as Json,
    });
    if (error) throw error;
  }

  private async omPatch(id: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await this.ctx.client.rpc("mastra_om_patch", {
      p_id: id,
      p_patch: { ...patch, updatedAt: new Date().toISOString() } as unknown as Json,
    });
    if (error) throw error;
  }

  private async omById(id: string): Promise<ObservationalMemoryRecord | null> {
    const { data, error } = await this.ctx.client
      .from(OM_TABLE)
      .select("record")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data ? this.parseOM((data as { record: Record<string, unknown> }).record) : null;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async getObservationalMemory(
    threadId: string | null,
    resourceId: string,
  ): Promise<ObservationalMemoryRecord | null> {
    const { data, error } = await this.ctx.client
      .from(OM_TABLE)
      .select("record")
      .eq("lookup_key", this.omKey(threadId, resourceId))
      .order("generation_count", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? this.parseOM((data as { record: Record<string, unknown> }).record) : null;
  }

  async getObservationalMemoryHistory(
    threadId: string | null,
    resourceId: string,
    limit = 10,
    options?: ObservationalMemoryHistoryOptions,
  ): Promise<ObservationalMemoryRecord[]> {
    let q = this.ctx.client
      .from(OM_TABLE)
      .select("record")
      .eq("lookup_key", this.omKey(threadId, resourceId))
      .order("generation_count", { ascending: false });
    if (options?.from) q = q.gte("created_at", options.from.toISOString());
    if (options?.to) q = q.lte("created_at", options.to.toISOString());
    const offset = options?.offset ?? 0;
    q = q.range(offset, offset + limit - 1);
    const { data, error } = await q;
    if (error) throw error;
    return ((data ?? []) as { record: Record<string, unknown> }[]).map((d) =>
      this.parseOM(d.record),
    );
  }

  // ── create ──────────────────────────────────────────────────────────────

  async initializeObservationalMemory(
    input: CreateObservationalMemoryInput,
  ): Promise<ObservationalMemoryRecord> {
    const now = new Date();
    const record: ObservationalMemoryRecord = {
      id: randomUUID(),
      scope: input.scope,
      threadId: input.threadId,
      resourceId: input.resourceId,
      createdAt: now,
      updatedAt: now,
      lastObservedAt: undefined,
      originType: "initial",
      generationCount: 0,
      activeObservations: "",
      totalTokensObserved: 0,
      observationTokenCount: 0,
      pendingMessageTokens: 0,
      isReflecting: false,
      isObserving: false,
      isBufferingObservation: false,
      isBufferingReflection: false,
      lastBufferedAtTokens: 0,
      lastBufferedAtTime: null,
      config: input.config,
      observedTimezone: input.observedTimezone,
    };
    await this.omUpsert(record);
    return record;
  }

  async insertObservationalMemoryRecord(record: ObservationalMemoryRecord): Promise<void> {
    await this.omUpsert(record);
  }

  async createReflectionGeneration(
    input: CreateReflectionGenerationInput,
  ): Promise<ObservationalMemoryRecord> {
    const now = new Date();
    const cur = input.currentRecord;
    const record: ObservationalMemoryRecord = {
      id: randomUUID(),
      scope: cur.scope,
      threadId: cur.threadId,
      resourceId: cur.resourceId,
      createdAt: now,
      updatedAt: now,
      lastObservedAt: cur.lastObservedAt,
      originType: "reflection",
      generationCount: cur.generationCount + 1,
      activeObservations: input.reflection,
      totalTokensObserved: cur.totalTokensObserved,
      observationTokenCount: input.tokenCount,
      pendingMessageTokens: 0,
      isReflecting: false,
      isObserving: false,
      isBufferingObservation: false,
      isBufferingReflection: false,
      lastBufferedAtTokens: 0,
      lastBufferedAtTime: null,
      config: cur.config,
      metadata: cur.metadata,
      observedTimezone: cur.observedTimezone,
    };
    await this.omUpsert(record);
    return record;
  }

  // ── field setters (shallow patch) ─────────────────────────────────────────

  async updateActiveObservations(input: UpdateActiveObservationsInput): Promise<void> {
    const cur = await this.omById(input.id);
    const tokens = Math.round(input.tokenCount);
    await this.omPatch(input.id, {
      activeObservations: input.observations,
      lastObservedAt: input.lastObservedAt.toISOString(),
      pendingMessageTokens: 0,
      observationTokenCount: tokens,
      totalTokensObserved: (cur?.totalTokensObserved ?? 0) + tokens,
      observedMessageIds: input.observedMessageIds ?? null,
      ...(input.observedTimezone ? { observedTimezone: input.observedTimezone } : {}),
    });
  }

  async setReflectingFlag(id: string, isReflecting: boolean): Promise<void> {
    await this.omPatch(id, { isReflecting });
  }

  async setObservingFlag(id: string, isObserving: boolean): Promise<void> {
    await this.omPatch(id, { isObserving });
  }

  async setBufferingObservationFlag(
    id: string,
    isBuffering: boolean,
    lastBufferedAtTokens?: number,
  ): Promise<void> {
    await this.omPatch(id, {
      isBufferingObservation: isBuffering,
      ...(lastBufferedAtTokens !== undefined
        ? { lastBufferedAtTokens: Math.round(lastBufferedAtTokens) }
        : {}),
    });
  }

  async setBufferingReflectionFlag(id: string, isBuffering: boolean): Promise<void> {
    await this.omPatch(id, { isBufferingReflection: isBuffering });
  }

  async setPendingMessageTokens(id: string, tokenCount: number): Promise<void> {
    await this.omPatch(id, { pendingMessageTokens: Math.round(tokenCount) });
  }

  async updateObservationalMemoryConfig(
    input: UpdateObservationalMemoryConfigInput,
  ): Promise<void> {
    const cur = await this.omById(input.id);
    await this.omPatch(input.id, { config: { ...(cur?.config ?? {}), ...input.config } });
  }

  async clearObservationalMemory(threadId: string | null, resourceId: string): Promise<void> {
    const { error } = await this.ctx.client.rpc("mastra_om_clear", {
      p_lookup_key: this.omKey(threadId, resourceId),
    });
    if (error) throw error;
  }

  // ── async buffering + reflection (logic ported from MemoryPG) ─────────────

  async updateBufferedObservations(input: UpdateBufferedObservationsInput): Promise<void> {
    const cur = await this.omById(input.id);
    const chunks = cur?.bufferedObservationChunks ?? [];
    const newChunk = {
      id: `ombuf-${randomUUID()}`,
      cycleId: input.chunk.cycleId,
      observations: input.chunk.observations,
      tokenCount: Math.round(input.chunk.tokenCount),
      messageIds: input.chunk.messageIds,
      messageTokens: Math.round(input.chunk.messageTokens ?? 0),
      lastObservedAt: input.chunk.lastObservedAt,
      createdAt: new Date().toISOString(),
      suggestedContinuation: input.chunk.suggestedContinuation,
      currentTask: input.chunk.currentTask,
      threadTitle: input.chunk.threadTitle,
    } as unknown as OMChunk;
    await this.omPatch(input.id, {
      bufferedObservationChunks: [...chunks, newChunk],
      ...(input.lastBufferedAtTime
        ? { lastBufferedAtTime: input.lastBufferedAtTime.toISOString() }
        : {}),
    });
  }

  async swapBufferedToActive(
    input: SwapBufferedToActiveInput,
  ): Promise<SwapBufferedToActiveResult> {
    const empty: SwapBufferedToActiveResult = {
      chunksActivated: 0,
      messageTokensActivated: 0,
      observationTokensActivated: 0,
      messagesActivated: 0,
      activatedCycleIds: [],
      activatedMessageIds: [],
    };
    const cur = await this.omById(input.id);
    if (!cur) throw new Error(`Observational memory record not found: ${input.id}`);
    const chunks = input.bufferedChunks ?? cur.bufferedObservationChunks ?? [];
    if (chunks.length === 0) return empty;

    const retentionFloor = input.messageTokensThreshold * (1 - input.activationRatio);
    const target = Math.max(0, input.currentPendingTokens - retentionFloor);
    let cumulative = 0;
    let bestOverBoundary = 0;
    let bestOverTokens = 0;
    let bestUnderBoundary = 0;
    let bestUnderTokens = 0;
    for (let i = 0; i < chunks.length; i++) {
      cumulative += chunks[i].messageTokens ?? 0;
      const boundary = i + 1;
      if (cumulative >= target) {
        if (bestOverBoundary === 0 || cumulative < bestOverTokens) {
          bestOverBoundary = boundary;
          bestOverTokens = cumulative;
        }
      } else if (cumulative > bestUnderTokens) {
        bestUnderBoundary = boundary;
        bestUnderTokens = cumulative;
      }
    }
    const maxOvershoot = retentionFloor * 0.95;
    const overshoot = bestOverTokens - target;
    const remainingAfterOver = input.currentPendingTokens - bestOverTokens;
    const remainingAfterUnder = input.currentPendingTokens - bestUnderTokens;
    const minRemaining = Math.min(1000, retentionFloor);
    let count: number;
    if (input.forceMaxActivation && bestOverBoundary > 0 && remainingAfterOver >= minRemaining) {
      count = bestOverBoundary;
    } else if (
      bestOverBoundary > 0 &&
      overshoot <= maxOvershoot &&
      remainingAfterOver >= minRemaining
    ) {
      count = bestOverBoundary;
    } else if (bestUnderBoundary > 0 && remainingAfterUnder >= minRemaining) {
      count = bestUnderBoundary;
    } else if (bestOverBoundary > 0) {
      count = bestOverBoundary;
    } else {
      count = 1;
    }

    const activated = chunks.slice(0, count);
    const remaining = chunks.slice(count);
    const content = activated.map((c) => c.observations).join("\n\n");
    const obsTokens = Math.round(activated.reduce((s, c) => s + c.tokenCount, 0));
    const msgTokens = Math.round(activated.reduce((s, c) => s + (c.messageTokens ?? 0), 0));
    const msgCount = activated.reduce((s, c) => s + c.messageIds.length, 0);
    const latest = activated[activated.length - 1] as
      | (OMChunk & {
          suggestedContinuation?: string;
          currentTask?: string;
        })
      | undefined;
    const lastObservedAt =
      input.lastObservedAt ??
      (latest?.lastObservedAt ? new Date(latest.lastObservedAt) : new Date());
    const boundary = `\n\n--- message boundary (${lastObservedAt.toISOString()}) ---\n\n`;
    const newActive =
      cur.activeObservations && cur.activeObservations !== ""
        ? cur.activeObservations + boundary + content
        : content;

    await this.omPatch(input.id, {
      activeObservations: newActive,
      observationTokenCount: (cur.observationTokenCount ?? 0) + obsTokens,
      pendingMessageTokens: Math.max(0, (cur.pendingMessageTokens ?? 0) - msgTokens),
      bufferedObservationChunks: remaining.length > 0 ? remaining : null,
      lastObservedAt: lastObservedAt.toISOString(),
    });

    return {
      chunksActivated: activated.length,
      messageTokensActivated: msgTokens,
      observationTokensActivated: obsTokens,
      messagesActivated: msgCount,
      activatedCycleIds: activated.map((c) => c.cycleId).filter((id): id is string => !!id),
      activatedMessageIds: activated.flatMap((c) => c.messageIds ?? []),
      observations: content,
      perChunk: activated.map((c) => ({
        cycleId: c.cycleId ?? "",
        messageTokens: c.messageTokens ?? 0,
        observationTokens: c.tokenCount,
        messageCount: c.messageIds.length,
        observations: c.observations,
      })),
      suggestedContinuation: latest?.suggestedContinuation,
      currentTask: latest?.currentTask,
    };
  }

  async updateBufferedReflection(input: UpdateBufferedReflectionInput): Promise<void> {
    const cur = await this.omById(input.id);
    const prev = cur?.bufferedReflection ?? "";
    await this.omPatch(input.id, {
      bufferedReflection: prev ? `${prev}\n\n${input.reflection}` : input.reflection,
      bufferedReflectionTokens: (cur?.bufferedReflectionTokens ?? 0) + Math.round(input.tokenCount),
      bufferedReflectionInputTokens:
        (cur?.bufferedReflectionInputTokens ?? 0) + Math.round(input.inputTokenCount),
      reflectedObservationLineCount: input.reflectedObservationLineCount,
    });
  }

  async swapBufferedReflectionToActive(
    input: SwapBufferedReflectionToActiveInput,
  ): Promise<ObservationalMemoryRecord> {
    const cur = await this.omById(input.currentRecord.id);
    if (!cur) throw new Error(`Observational memory record not found: ${input.currentRecord.id}`);
    const bufferedReflection = cur.bufferedReflection ?? "";
    if (!bufferedReflection) throw new Error("No buffered reflection to swap");
    const reflectedLineCount = cur.reflectedObservationLineCount ?? 0;
    const unreflected = (cur.activeObservations ?? "")
      .split("\n")
      .slice(reflectedLineCount)
      .join("\n")
      .trim();
    const newObservations = unreflected
      ? `${bufferedReflection}\n\n${unreflected}`
      : bufferedReflection;
    const newRecord = await this.createReflectionGeneration({
      currentRecord: input.currentRecord,
      reflection: newObservations,
      tokenCount: input.tokenCount,
    });
    await this.omPatch(input.currentRecord.id, {
      bufferedReflection: null,
      bufferedReflectionTokens: null,
      bufferedReflectionInputTokens: null,
      reflectedObservationLineCount: null,
    });
    return newRecord;
  }
}
