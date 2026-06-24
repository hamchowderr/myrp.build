/**
 * Message-domain methods for the cloud adapter, split out of memory.ts to keep
 * each file under the 500-line cap (z8j8.6). SupabaseMemoryStorage extends this
 * (which in turn extends the observational-memory base), so messages, threads,
 * resources, and clone all live on the one MemoryStorage subclass — just across
 * separate files. Reads go through RLS-protected tables; writes (saveMessages /
 * updateMessages) through SECURITY DEFINER RPCs.
 */
import { type MastraDBMessage, type MastraMessageContentV2, MessageList } from "@mastra/core/agent";
import type {
  StorageListMessagesByResourceIdInput,
  StorageListMessagesInput,
  StorageListMessagesOutput,
} from "@mastra/core/storage";
import type { Json } from "../../../types/database";
import { SupabaseObservationalMemory } from "./observational";

export const MESSAGES = "mastra_messages";
// Columns selected for messages, mapped to the Mastra row shape by parseRow.
export const MESSAGE_COLS = "id, thread_id, resource_id, role, type, content, created_at";

/** Raw mastra_messages row (snake_case DB columns). */
export interface MessageRow {
  id: string;
  thread_id: string;
  resource_id: string | null;
  role: string;
  type: string;
  content: unknown;
  created_at: string;
}

export abstract class SupabaseMessageStorage extends SupabaseObservationalMemory {
  /** Map a message DB row to the Mastra DB-message shape (pre-normalization). */
  protected parseRow(row: MessageRow): MastraDBMessage {
    let content = row.content as MastraMessageContentV2;
    if (typeof row.content === "string") {
      try {
        content = JSON.parse(row.content) as MastraMessageContentV2;
      } catch {
        // leave as-is if not JSON (defensive; content is jsonb in DB)
      }
    }
    return {
      id: row.id,
      content,
      role: row.role as MastraDBMessage["role"],
      createdAt: new Date(row.created_at),
      threadId: row.thread_id,
      resourceId: row.resource_id ?? undefined,
      ...(row.type && row.type !== "v2" ? { type: row.type } : {}),
    };
  }

  /** Normalize parsed rows through MessageList (mirrors @mastra/pg). */
  protected normalize(rows: MessageRow[]): MastraDBMessage[] {
    const list = new MessageList().add(
      rows.map((r) => this.parseRow(r)),
      "memory",
    );
    return list.get.all.db();
  }

  async listMessages(args: StorageListMessagesInput): Promise<StorageListMessagesOutput> {
    const { threadId, resourceId, filter, perPage: perPageInput, page = 0, orderBy } = args;
    const threadIds = (Array.isArray(threadId) ? threadId : [threadId]).filter(
      (id): id is string => typeof id === "string" && id.trim() !== "",
    );
    if (threadIds.length === 0) {
      throw new Error("threadId must be a non-empty string or array of non-empty strings");
    }
    const { field, direction } = this.parseOrderBy(orderBy, "ASC");
    const orderCol = field === "updatedAt" ? "updated_at" : "created_at";
    const perPage = perPageInput === false ? null : (perPageInput ?? 40);

    let query = this.ctx.client
      .from(MESSAGES)
      .select(MESSAGE_COLS, { count: "exact" })
      .in("thread_id", threadIds)
      .order(orderCol, { ascending: direction === "ASC" });
    if (resourceId) query = query.eq("resource_id", resourceId);
    if (filter?.dateRange?.start) {
      const startCol = filter.dateRange.startExclusive ? "gt" : "gte";
      query = query[startCol]("created_at", filter.dateRange.start.toISOString());
    }
    if (filter?.dateRange?.end) {
      const endCol = filter.dateRange.endExclusive ? "lt" : "lte";
      query = query[endCol]("created_at", filter.dateRange.end.toISOString());
    }
    if (perPage !== null) {
      const offset = page * perPage;
      query = query.range(offset, offset + perPage - 1);
    }
    const { data, error, count } = await query;
    if (error) throw error;
    const total = count ?? 0;
    const messages = this.normalize((data ?? []) as unknown as MessageRow[]);
    const hasMore = perPage === null ? false : page * perPage + messages.length < total;
    return { messages, total, page, perPage: perPageInput ?? 40, hasMore };
  }

  async listMessagesByResourceId(
    args: StorageListMessagesByResourceIdInput,
  ): Promise<StorageListMessagesOutput> {
    const { resourceId, filter, perPage: perPageInput, page = 0, orderBy } = args;
    if (!resourceId || resourceId.trim() === "") {
      throw new Error("resourceId is required");
    }
    const { field, direction } = this.parseOrderBy(orderBy, "ASC");
    const orderCol = field === "updatedAt" ? "updated_at" : "created_at";
    const perPage = perPageInput === false ? null : (perPageInput ?? 40);

    let query = this.ctx.client
      .from(MESSAGES)
      .select(MESSAGE_COLS, { count: "exact" })
      .eq("resource_id", resourceId)
      .order(orderCol, { ascending: direction === "ASC" });
    if (filter?.dateRange?.start) {
      const startCol = filter.dateRange.startExclusive ? "gt" : "gte";
      query = query[startCol]("created_at", filter.dateRange.start.toISOString());
    }
    if (filter?.dateRange?.end) {
      const endCol = filter.dateRange.endExclusive ? "lt" : "lte";
      query = query[endCol]("created_at", filter.dateRange.end.toISOString());
    }
    if (perPage !== null) {
      const offset = page * perPage;
      query = query.range(offset, offset + perPage - 1);
    }
    const { data, error, count } = await query;
    if (error) throw error;
    const total = count ?? 0;
    const messages = this.normalize((data ?? []) as unknown as MessageRow[]);
    const hasMore = perPage === null ? false : page * perPage + messages.length < total;
    return { messages, total, page, perPage: perPageInput ?? 40, hasMore };
  }

  async listMessagesById({
    messageIds,
  }: {
    messageIds: string[];
  }): Promise<{ messages: MastraDBMessage[] }> {
    if (messageIds.length === 0) return { messages: [] };
    const { data, error } = await this.ctx.client
      .from(MESSAGES)
      .select(MESSAGE_COLS)
      .in("id", messageIds)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return { messages: this.normalize((data ?? []) as unknown as MessageRow[]) };
  }

  async saveMessages({
    messages,
  }: {
    messages: MastraDBMessage[];
  }): Promise<{ messages: MastraDBMessage[] }> {
    if (messages.length === 0) return { messages: [] };
    const payload = messages.map((m) => ({
      id: m.id,
      threadId: m.threadId,
      role: m.role,
      type: m.type ?? "v2",
      resourceId: m.resourceId ?? this.ctx.resourceId,
      content: m.content,
      createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
    }));
    const { error } = await this.ctx.client.rpc("mastra_save_messages", {
      p_messages: payload as unknown as Json,
    });
    if (error) throw error;
    // Return the input normalized (mirrors @mastra/pg's return contract).
    const list = new MessageList().add(messages, "memory");
    return { messages: list.get.all.db() };
  }

  async updateMessages(args: {
    messages: (Partial<Omit<MastraDBMessage, "createdAt">> & {
      id: string;
      content?: {
        metadata?: MastraMessageContentV2["metadata"];
        content?: MastraMessageContentV2["content"];
      };
    })[];
  }): Promise<MastraDBMessage[]> {
    if (args.messages.length === 0) return [];
    const payload = args.messages.map((m) => {
      const out: Record<string, unknown> = { id: m.id };
      if (m.content !== undefined) out.content = m.content;
      if (m.role !== undefined) out.role = m.role;
      if (m.type !== undefined) out.type = m.type;
      return out;
    });
    const { error } = await this.ctx.client.rpc("mastra_update_messages", {
      p_messages: payload as unknown as Json,
    });
    if (error) throw error;
    const ids = args.messages.map((m) => m.id);
    const { messages } = await this.listMessagesById({ messageIds: ids });
    return messages;
  }
}
