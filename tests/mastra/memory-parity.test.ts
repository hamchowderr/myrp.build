import { describe, expect, it } from "vitest";
import type { RunStorageContext } from "../../src/main/mastra/storage/context";
import { SupabaseMemoryStorage } from "../../src/main/mastra/storage/memory";
import type { RunSupabaseClient } from "../../src/main/mastra/storage/supabase-client";

// deleteMessages + resource-scoped working memory bring the cloud
// adapter to @mastra/pg MemoryPG parity. Both go through SECURITY DEFINER RPCs;
// here we stub the run client and assert the right RPC + args are issued and rows
// map back to the Mastra shape.

interface RpcCall {
  name: string;
  args: any;
}

interface ResourceRow {
  id: string;
  working_memory: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

function makeCtx(resourceRow?: ResourceRow): { ctx: RunStorageContext; rpcCalls: RpcCall[] } {
  const rpcCalls: RpcCall[] = [];

  function builder(table: string) {
    const b: any = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => ({
        data: table === "mastra_resources" ? (resourceRow ?? null) : null,
        error: null,
      }),
    };
    return b;
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return { error: null };
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

describe("SupabaseMemoryStorage.deleteMessages", () => {
  it("calls the delete RPC with the message ids", async () => {
    const { ctx, rpcCalls } = makeCtx();
    await new SupabaseMemoryStorage(ctx).deleteMessages(["m1", "m2"]);
    const call = rpcCalls.find((c) => c.name === "mastra_delete_messages");
    expect(call?.args.p_message_ids).toEqual(["m1", "m2"]);
  });

  it("is a no-op for an empty id list (no RPC)", async () => {
    const { ctx, rpcCalls } = makeCtx();
    await new SupabaseMemoryStorage(ctx).deleteMessages([]);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("SupabaseMemoryStorage resource working memory", () => {
  const row: ResourceRow = {
    id: "ws_a__srv_b",
    working_memory: "# notes",
    metadata: { a: 1 },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
  };

  it("getResourceById maps a row to the Mastra resource shape", async () => {
    const { ctx } = makeCtx(row);
    const res = await new SupabaseMemoryStorage(ctx).getResourceById({ resourceId: "ws_a__srv_b" });
    expect(res?.id).toBe("ws_a__srv_b");
    expect(res?.workingMemory).toBe("# notes");
    expect(res?.metadata).toEqual({ a: 1 });
    expect(res?.createdAt).toBeInstanceOf(Date);
  });

  it("getResourceById returns null when absent", async () => {
    const { ctx } = makeCtx();
    expect(await new SupabaseMemoryStorage(ctx).getResourceById({ resourceId: "x" })).toBeNull();
  });

  it("saveResource issues mastra_save_resource scoped to the ctx workspace", async () => {
    const { ctx, rpcCalls } = makeCtx();
    await new SupabaseMemoryStorage(ctx).saveResource({
      resource: {
        id: "ws_a__srv_b",
        workingMemory: "wm",
        metadata: { k: "v" },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const call = rpcCalls.find((c) => c.name === "mastra_save_resource");
    expect(call?.args.p_id).toBe("ws_a__srv_b");
    expect(call?.args.p_workspace_id).toBe("ws-1");
    expect(call?.args.p_working_memory).toBe("wm");
    expect(call?.args.p_metadata).toEqual({ k: "v" });
  });

  it("updateResource updates an existing resource (merging metadata)", async () => {
    const { ctx, rpcCalls } = makeCtx(row);
    const out = await new SupabaseMemoryStorage(ctx).updateResource({
      resourceId: "ws_a__srv_b",
      workingMemory: "new",
      metadata: { b: 2 },
    });
    expect(rpcCalls.find((c) => c.name === "mastra_update_resource")?.args.p_working_memory).toBe(
      "new",
    );
    expect(out.workingMemory).toBe("new");
    expect(out.metadata).toEqual({ a: 1, b: 2 });
  });

  it("updateResource creates the resource when it does not exist", async () => {
    const { ctx, rpcCalls } = makeCtx();
    await new SupabaseMemoryStorage(ctx).updateResource({
      resourceId: "ws_a__srv_b",
      workingMemory: "first",
    });
    expect(rpcCalls.find((c) => c.name === "mastra_save_resource")).toBeTruthy();
    expect(rpcCalls.find((c) => c.name === "mastra_update_resource")).toBeUndefined();
  });
});
