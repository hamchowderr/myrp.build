/**
 * Cloud Supabase vector store for Mastra semantic recall.
 *
 * Implements @mastra/core's abstract MastraVector against cloud Supabase pgvector
 * the SAME secure way as the memory adapter: reads go through an RLS-aware
 * SECURITY DEFINER match RPC, writes through SECURITY DEFINER upsert/delete RPCs
 * (supabase-js, anon key + per-run JWT — no DB credential ships). The embeddings
 * table + HNSW index are created by migration (20260609010000, resized to 384 by
 * 20260623120000), so index lifecycle here is a no-op; the dimension is fixed at
 * 384 (fastembed bge-small-en-v1.5).
 *
 * Mastra's semantic-recall path only calls query()/upsert()/createIndex(); the
 * other MastraVector methods are implemented where they map cleanly to an RPC
 * (id-based deletes) and otherwise throw a clear error rather than pretend.
 */
import { randomUUID } from "node:crypto";
import type {
  CreateIndexParams,
  DeleteIndexParams,
  DeleteVectorParams,
  DeleteVectorsParams,
  DescribeIndexParams,
  IndexStats,
  QueryResult,
  QueryVectorParams,
  UpdateVectorParams,
  UpsertVectorParams,
} from "@mastra/core/vector";
import { MastraVector } from "@mastra/core/vector";
import type { Json } from "../../../types/database";
import type { RunStorageContext } from "./context";

const INDEX_NAME = "mastra_message_embeddings";
const DIMENSION = 384;

interface MatchRow {
  id: string;
  message_id: string | null;
  thread_id: string | null;
  resource_id: string | null;
  content: string | null;
  metadata: Record<string, unknown> | null;
  similarity: number;
}

export class SupabaseVector extends MastraVector {
  private readonly ctx: RunStorageContext;

  constructor(ctx: RunStorageContext) {
    super({ id: "myrp-build-cloud-vector", disableInit: true });
    this.ctx = ctx;
  }

  async upsert({ vectors, metadata, ids }: UpsertVectorParams): Promise<string[]> {
    const outIds = vectors.map((_, i) => ids?.[i] ?? randomUUID());
    const rows = vectors.map((vec, i) => {
      const md = (metadata?.[i] ?? {}) as Record<string, unknown>;
      return {
        id: outIds[i],
        message_id: md.message_id ?? null,
        thread_id: md.thread_id ?? null,
        resource_id: md.resource_id ?? null,
        content: md.content ?? null,
        metadata: md,
        // Stored as a JSON array; the RPC casts (row->>'embedding')::vector.
        embedding: vec,
      };
    });
    const { error } = await this.ctx.client.rpc("mastra_upsert_embeddings", {
      p_workspace_id: this.ctx.workspaceId,
      p_rows: rows as unknown as Json,
    });
    if (error) throw error;
    return outIds;
  }

  async query({ queryVector, topK = 10, filter }: QueryVectorParams): Promise<QueryResult[]> {
    if (!queryVector) return [];
    const f = (filter ?? {}) as { thread_id?: string; resource_id?: string };
    const args: Record<string, unknown> = {
      p_workspace_id: this.ctx.workspaceId,
      // pgvector coerces the "[..]" text literal to vector via the typed arg.
      query_embedding: `[${queryVector.join(",")}]`,
      match_count: topK,
    };
    if (f.thread_id) args.p_thread_id = f.thread_id;
    if (f.resource_id) args.p_resource_id = f.resource_id;
    const { data, error } = await this.ctx.client.rpc("mastra_match_embeddings", args as never);
    if (error) throw error;
    return ((data ?? []) as MatchRow[]).map((r) => ({
      id: r.id,
      score: r.similarity,
      metadata: {
        message_id: r.message_id,
        thread_id: r.thread_id,
        resource_id: r.resource_id,
        content: r.content,
        ...(r.metadata ?? {}),
      },
    }));
  }

  // Index lifecycle is migration-managed (table + HNSW index live in SQL,
  // dimension fixed at 384), so createIndex is a no-op.
  async createIndex(_params: CreateIndexParams): Promise<void> {}

  async listIndexes(): Promise<string[]> {
    return [INDEX_NAME];
  }

  async describeIndex(_params: DescribeIndexParams): Promise<IndexStats> {
    return { dimension: DIMENSION, count: 0, metric: "cosine" };
  }

  async deleteIndex(_params: DeleteIndexParams): Promise<void> {
    throw new Error(
      "deleteIndex is not supported by SupabaseVector (the embeddings table is migration-managed).",
    );
  }

  async deleteVector({ id }: DeleteVectorParams): Promise<void> {
    await this.deleteVectors({ indexName: INDEX_NAME, ids: [id] });
  }

  async deleteVectors(params: DeleteVectorsParams): Promise<void> {
    if (!params.ids || params.ids.length === 0) {
      throw new Error(
        "SupabaseVector.deleteVectors supports id-based deletion only (no metadata-filter deletes through the JWT client).",
      );
    }
    const { error } = await this.ctx.client.rpc("mastra_delete_embeddings", {
      p_ids: params.ids,
    });
    if (error) throw error;
  }

  async updateVector(_params: UpdateVectorParams): Promise<void> {
    throw new Error(
      "updateVector is not supported by SupabaseVector; re-upsert the vector instead.",
    );
  }
}
