/**
 * Cloud Supabase memory storage adapter (M2.3 — fivem-studio-825).
 *
 * Implements the @mastra/core 1.41 abstract MemoryStorage set against cloud
 * Supabase, the SECURE way: reads go through the RLS-protected tables
 * (mastra_threads / mastra_messages, gated by is_workspace_member), writes go
 * through the SECURITY DEFINER RPCs (mastra_save_thread / mastra_update_thread /
 * mastra_delete_thread / mastra_save_messages / mastra_update_messages) which
 * re-check membership and stamp identity from auth.uid()/auth.email(). The run
 * client (anon key + per-run JWT) carries no DB credential.
 *
 * Row shape mirrors @mastra/pg's memory domain so MessageList normalization and
 * the agent's recall behave identically — content is jsonb (MastraMessageContentV2),
 * and rows are mapped to the Mastra message shape (id, content, role, type,
 * createdAt, threadId, resourceId) via MessageList().add(..., "memory").get.all.db().
 *
 * Workflow snapshots are NOT here — they stay local (M1's InMemoryStore). Only
 * conversational memory is cloud-backed. This class owns threads, resources, and
 * clone; messages live in messages.ts (SupabaseMessageStorage) and observational
 * memory in observational.ts (SupabaseObservationalMemory), both extended here to
 * keep each file under the 500-line cap.
 */
import { randomUUID } from "node:crypto";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { StorageThreadType } from "@mastra/core/memory";
import type {
  StorageCloneThreadInput,
  StorageCloneThreadOutput,
  StorageListThreadsInput,
  StorageListThreadsOutput,
  StorageResourceType,
} from "@mastra/core/storage";
import type { Database, Json } from "../../../types/database";
import { MESSAGE_COLS, MESSAGES, type MessageRow, SupabaseMessageStorage } from "./messages";

/** Raw mastra_threads row. */
interface ThreadRow {
  id: string;
  resource_id: string;
  title: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

/** Raw mastra_resources row (resource-scoped working memory). */
interface ResourceRow {
  id: string;
  working_memory: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

const THREADS = "mastra_threads";
const RESOURCES = "mastra_resources";

export class SupabaseMemoryStorage extends SupabaseMessageStorage {
  // ctx + observational-memory methods come from SupabaseObservationalMemory;
  // message-domain methods (list/save/update + parseRow/normalize) from
  // SupabaseMessageStorage. This class owns threads, resources, and clone.

  // Tables are created by migrations (M2.1), not at runtime. No-op init.
  override async init(): Promise<void> {}

  /** Map a thread DB row to the Mastra StorageThreadType. */
  private parseThread(row: ThreadRow): StorageThreadType {
    return {
      id: row.id,
      resourceId: row.resource_id,
      title: row.title ?? undefined,
      metadata:
        typeof row.metadata === "string"
          ? (JSON.parse(row.metadata) as Record<string, unknown>)
          : ((row.metadata as Record<string, unknown> | null) ?? undefined),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  // ── threads ─────────────────────────────────────────────────────────────

  async getThreadById({
    threadId,
    resourceId,
  }: {
    threadId: string;
    resourceId?: string;
  }): Promise<StorageThreadType | null> {
    let query = this.ctx.client.from(THREADS).select("*").eq("id", threadId);
    if (resourceId !== undefined) query = query.eq("resource_id", resourceId);
    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    return data ? this.parseThread(data as ThreadRow) : null;
  }

  async listThreads(args: StorageListThreadsInput): Promise<StorageListThreadsOutput> {
    const { page = 0, perPage: perPageInput, orderBy, filter } = args;
    this.validateMetadataKeys(filter?.metadata);
    const { field, direction } = this.parseOrderBy(orderBy);
    const perPage = perPageInput === false ? null : (perPageInput ?? 100);

    let query = this.ctx.client
      .from(THREADS)
      .select("*", { count: "exact" })
      .order(field === "updatedAt" ? "updated_at" : "created_at", {
        ascending: direction === "ASC",
      });
    if (filter?.resourceId) query = query.eq("resource_id", filter.resourceId);
    if (filter?.metadata) {
      for (const [k, v] of Object.entries(filter.metadata)) {
        query = query.contains("metadata", { [k]: v });
      }
    }
    if (perPage !== null) {
      const offset = page * perPage;
      query = query.range(offset, offset + perPage - 1);
    }
    const { data, error, count } = await query;
    if (error) throw error;
    const total = count ?? 0;
    const threads = (data ?? []).map((r) => this.parseThread(r as ThreadRow));
    const hasMore = perPage === null ? false : page * perPage + threads.length < total;
    return { threads, total, page, perPage: perPageInput ?? 100, hasMore };
  }

  async saveThread({ thread }: { thread: StorageThreadType }): Promise<StorageThreadType> {
    // Optional RPC args (server_id / title / metadata) have SQL defaults, so omit
    // them when absent rather than passing null (the typed Args don't accept null).
    const args: Database["public"]["Functions"]["mastra_save_thread"]["Args"] = {
      p_thread_id: thread.id,
      p_workspace_id: this.ctx.workspaceId,
      p_resource_id: thread.resourceId,
    };
    if (this.ctx.serverId !== null) args.p_server_id = this.ctx.serverId;
    if (thread.title !== undefined) args.p_title = thread.title;
    if (thread.metadata !== undefined) args.p_metadata = thread.metadata as Json;
    const { error } = await this.ctx.client.rpc("mastra_save_thread", args);
    if (error) throw error;
    return thread;
  }

  async updateThread({
    id,
    title,
    metadata,
  }: {
    id: string;
    title: string;
    metadata: Record<string, unknown>;
  }): Promise<StorageThreadType> {
    const args: Database["public"]["Functions"]["mastra_update_thread"]["Args"] = {
      p_id: id,
      p_title: title,
    };
    if (metadata !== undefined) args.p_metadata = metadata as Json;
    const { error } = await this.ctx.client.rpc("mastra_update_thread", args);
    if (error) throw error;
    const updated = await this.getThreadById({ threadId: id });
    if (!updated) throw new Error(`Thread ${id} not found after update`);
    return updated;
  }

  async deleteThread({ threadId }: { threadId: string }): Promise<void> {
    const { error } = await this.ctx.client.rpc("mastra_delete_thread", {
      p_thread_id: threadId,
    });
    if (error) throw error;
  }

  /**
   * Clone a thread and its messages into a new independent thread — Mastra's
   * native clone primitive (Memory.cloneThread() delegates here). Mirrors
   * @mastra/pg MemoryPG.cloneThread semantics: same clone metadata
   * ({ sourceThreadId, clonedAt, lastMessageId }), a `Clone of <title>` default
   * title, and a messageIdMap (source id → new id) for OM remapping. Composed
   * from our existing primitives — RLS-gated reads + SECURITY DEFINER write RPCs
   * (saveThread/saveMessages) — so no new DB credential or runtime DDL is needed.
   * The new thread inherits the source resourceId, keeping workspace/server scope.
   */
  async cloneThread(args: StorageCloneThreadInput): Promise<StorageCloneThreadOutput> {
    const {
      sourceThreadId,
      newThreadId: providedThreadId,
      resourceId,
      title,
      metadata,
      options,
    } = args;

    const sourceThread = await this.getThreadById({ threadId: sourceThreadId });
    if (!sourceThread) {
      throw new Error(`Source thread with id ${sourceThreadId} not found`);
    }
    const newThreadId = providedThreadId ?? randomUUID();
    if (await this.getThreadById({ threadId: newThreadId })) {
      throw new Error(`Thread with id ${newThreadId} already exists`);
    }

    const sourceMessages = await this.fetchMessagesForClone(sourceThreadId, options);
    const targetResourceId = resourceId ?? sourceThread.resourceId;
    const now = new Date();
    const lastMessageId =
      sourceMessages.length > 0 ? sourceMessages[sourceMessages.length - 1].id : undefined;
    const cloneMetadata = {
      sourceThreadId,
      clonedAt: now,
      ...(lastMessageId ? { lastMessageId } : {}),
    };

    const newThread: StorageThreadType = {
      id: newThreadId,
      resourceId: targetResourceId,
      title: title ?? (sourceThread.title ? `Clone of ${sourceThread.title}` : undefined),
      metadata: { ...(metadata ?? {}), clone: cloneMetadata },
      createdAt: now,
      updatedAt: now,
    };
    await this.saveThread({ thread: newThread });

    const messageIdMap: Record<string, string> = {};
    const clonedMessages: MastraDBMessage[] = sourceMessages.map((m) => {
      const id = randomUUID();
      messageIdMap[m.id] = id;
      return { ...m, id, threadId: newThreadId, resourceId: targetResourceId };
    });
    if (clonedMessages.length > 0) await this.saveMessages({ messages: clonedMessages });

    return { thread: newThread, clonedMessages, messageIdMap };
  }

  /** Read a thread's messages for cloning, honoring the optional clone filters. */
  private async fetchMessagesForClone(
    threadId: string,
    options: StorageCloneThreadInput["options"],
  ): Promise<MastraDBMessage[]> {
    let query = this.ctx.client.from(MESSAGES).select(MESSAGE_COLS).eq("thread_id", threadId);
    const f = options?.messageFilter;
    if (f?.startDate) query = query.gte("created_at", f.startDate.toISOString());
    if (f?.endDate) query = query.lte("created_at", f.endDate.toISOString());
    if (f?.messageIds && f.messageIds.length > 0) query = query.in("id", f.messageIds);

    const limit = options?.messageLimit;
    if (limit && limit > 0) {
      // "most recent N": pull DESC + limit, then restore chronological order.
      const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      return this.normalize(((data ?? []) as unknown as MessageRow[]).reverse());
    }
    const { data, error } = await query.order("created_at", { ascending: true });
    if (error) throw error;
    return this.normalize((data ?? []) as unknown as MessageRow[]);
  }

  /** Delete messages by id (via the SECURITY DEFINER RPC; bumps thread updated_at). */
  async deleteMessages(messageIds: string[]): Promise<void> {
    if (!messageIds || messageIds.length === 0) return;
    const { error } = await this.ctx.client.rpc("mastra_delete_messages", {
      p_message_ids: messageIds,
    });
    if (error) throw error;
  }

  // ── resources (resource-scoped working memory) ───────────────────────────

  async getResourceById({
    resourceId,
  }: {
    resourceId: string;
  }): Promise<StorageResourceType | null> {
    const { data, error } = await this.ctx.client
      .from(RESOURCES)
      .select("*")
      .eq("id", resourceId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as ResourceRow;
    return {
      id: row.id,
      workingMemory: row.working_memory ?? undefined,
      metadata:
        typeof row.metadata === "string"
          ? (JSON.parse(row.metadata) as Record<string, unknown>)
          : ((row.metadata as Record<string, unknown> | null) ?? undefined),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  async saveResource({
    resource,
  }: {
    resource: StorageResourceType;
  }): Promise<StorageResourceType> {
    const args: Database["public"]["Functions"]["mastra_save_resource"]["Args"] = {
      p_id: resource.id,
      p_workspace_id: this.ctx.workspaceId,
    };
    if (resource.workingMemory !== undefined) args.p_working_memory = resource.workingMemory;
    if (resource.metadata !== undefined) args.p_metadata = resource.metadata as Json;
    const { error } = await this.ctx.client.rpc("mastra_save_resource", args);
    if (error) throw error;
    return resource;
  }

  async updateResource({
    resourceId,
    workingMemory,
    metadata,
  }: {
    resourceId: string;
    workingMemory?: string;
    metadata?: Record<string, unknown>;
  }): Promise<StorageResourceType> {
    const existing = await this.getResourceById({ resourceId });
    if (!existing) {
      // Mirror @mastra/pg: an update against a missing resource creates it.
      return this.saveResource({
        resource: {
          id: resourceId,
          workingMemory,
          metadata: metadata ?? {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }
    const args: Database["public"]["Functions"]["mastra_update_resource"]["Args"] = {
      p_id: resourceId,
    };
    if (workingMemory !== undefined) args.p_working_memory = workingMemory;
    if (metadata !== undefined) args.p_metadata = metadata as Json;
    const { error } = await this.ctx.client.rpc("mastra_update_resource", args);
    if (error) throw error;
    return {
      ...existing,
      workingMemory: workingMemory !== undefined ? workingMemory : existing.workingMemory,
      metadata: { ...(existing.metadata ?? {}), ...(metadata ?? {}) },
      updatedAt: new Date(),
    };
  }

  // Destructive bulk clear is not supported through the JWT-scoped client (no
  // bulk-delete RPC; deletion is per-thread via mastra_delete_thread). Required
  // only for test harnesses, which we don't run against the cloud.
  async dangerouslyClearAll(): Promise<void> {
    throw new Error(
      "dangerouslyClearAll is not supported by SupabaseMemoryStorage (per-thread delete only).",
    );
  }
}
