import { describe, expect, it } from "vitest";
import type { RunStorageContext } from "../../src/main/mastra/storage/context";
import type { RunSupabaseClient } from "../../src/main/mastra/storage/supabase-client";
import { SupabaseVector } from "../../src/main/mastra/storage/vector";

// SupabaseVector backs Mastra semantic recall on cloud pgvector via
// SECURITY DEFINER RPCs. Stub the run client and assert upsert/query/delete issue
// the right RPC + args and map rows back to the MastraVector QueryResult shape.

interface RpcCall {
  name: string;
  args: any;
}

const MATCH_ROWS = [
  {
    id: "v1",
    message_id: "m1",
    thread_id: "t1",
    resource_id: null,
    content: "hello",
    metadata: { tag: "x" },
    similarity: 0.91,
  },
];

function makeCtx(): { ctx: RunStorageContext; rpcCalls: RpcCall[] } {
  const rpcCalls: RpcCall[] = [];
  const client = {
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return { data: name === "mastra_match_embeddings" ? MATCH_ROWS : null, error: null };
    },
  } as unknown as RunSupabaseClient;
  const ctx: RunStorageContext = {
    client,
    workspaceId: "ws-1",
    serverId: null,
    resourceId: "ws_a__srv_b",
    authorId: "author-1",
    authorEmail: "a@b.c",
  };
  return { ctx, rpcCalls };
}

describe("SupabaseVector", () => {
  it("upsert writes rows through mastra_upsert_embeddings and returns the ids", async () => {
    const { ctx, rpcCalls } = makeCtx();
    const ids = await new SupabaseVector(ctx).upsert({
      indexName: "mastra_message_embeddings",
      vectors: [[0.1, 0.2, 0.3]],
      metadata: [{ message_id: "m1", thread_id: "t1", resource_id: "r1", content: "hi" }],
      ids: ["v1"],
    });
    expect(ids).toEqual(["v1"]);
    const call = rpcCalls.find((c) => c.name === "mastra_upsert_embeddings");
    expect(call?.args.p_workspace_id).toBe("ws-1");
    expect(call?.args.p_rows[0].id).toBe("v1");
    expect(call?.args.p_rows[0].thread_id).toBe("t1");
    expect(call?.args.p_rows[0].embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("upsert generates ids when none are provided", async () => {
    const { ctx } = makeCtx();
    const ids = await new SupabaseVector(ctx).upsert({
      indexName: "mastra_message_embeddings",
      vectors: [[0.1], [0.2]],
      metadata: [{}, {}],
    });
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("query passes the filter scope and maps results to QueryResult", async () => {
    const { ctx, rpcCalls } = makeCtx();
    const res = await new SupabaseVector(ctx).query({
      indexName: "mastra_message_embeddings",
      queryVector: [0.1, 0.2, 0.3],
      topK: 3,
      filter: { thread_id: "t1" },
    });
    const call = rpcCalls.find((c) => c.name === "mastra_match_embeddings");
    expect(call?.args.p_thread_id).toBe("t1");
    expect(call?.args.match_count).toBe(3);
    expect(call?.args.query_embedding).toBe("[0.1,0.2,0.3]");
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe("v1");
    expect(res[0].score).toBe(0.91);
    expect(res[0].metadata?.message_id).toBe("m1");
    expect(res[0].metadata?.tag).toBe("x");
  });

  it("query short-circuits to [] without a query vector", async () => {
    const { ctx, rpcCalls } = makeCtx();
    const res = await new SupabaseVector(ctx).query({ indexName: "mastra_message_embeddings" });
    expect(res).toEqual([]);
    expect(rpcCalls).toHaveLength(0);
  });

  it("deleteVectors removes by id via mastra_delete_embeddings", async () => {
    const { ctx, rpcCalls } = makeCtx();
    await new SupabaseVector(ctx).deleteVectors({
      indexName: "mastra_message_embeddings",
      ids: ["v1", "v2"],
    });
    expect(rpcCalls.find((c) => c.name === "mastra_delete_embeddings")?.args.p_ids).toEqual([
      "v1",
      "v2",
    ]);
  });

  it("createIndex is a no-op (migration-managed) and updateVector is unsupported", async () => {
    const { ctx, rpcCalls } = makeCtx();
    const v = new SupabaseVector(ctx);
    await expect(
      v.createIndex({ indexName: "mastra_message_embeddings", dimension: 1536 }),
    ).resolves.toBeUndefined();
    expect(rpcCalls).toHaveLength(0);
    await expect(
      v.updateVector({ indexName: "x", id: "v1", update: { vector: [0.1] } }),
    ).rejects.toThrow(/not supported/);
  });
});
