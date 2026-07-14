import { describe, expect, it } from "vitest";
import type { RunStorageContext } from "../../src/main/mastra/storage/context";
import { SupabaseMemoryStorage } from "../../src/main/mastra/storage/memory";
import type { RunSupabaseClient } from "../../src/main/mastra/storage/supabase-client";

// observational-memory parity. The observe/buffer/reflect logic runs in
// the adapter (JS) over a jsonb document, persisted via SECURITY DEFINER RPCs.
// Stub the run client and assert the right RPC + args, record mapping, the
// token-total accumulation, and the swap activation logic.

interface RpcCall {
  name: string;
  args: any;
}

function makeCtx(record?: Record<string, unknown>): {
  ctx: RunStorageContext;
  rpcCalls: RpcCall[];
} {
  const rpcCalls: RpcCall[] = [];
  function builder() {
    const b: any = {
      select: () => b,
      eq: () => b,
      order: () => b,
      limit: () => b,
      gte: () => b,
      lte: () => b,
      range: () => b,
      maybeSingle: async () => ({ data: record ? { record } : null, error: null }),
    };
    return b;
  }
  const client = {
    from: () => builder(),
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return { data: null, error: null };
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

const BASE_RECORD = {
  id: "om1",
  scope: "thread",
  threadId: "t1",
  resourceId: "r1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  originType: "initial",
  generationCount: 2,
  activeObservations: "existing notes",
  totalTokensObserved: 10,
  observationTokenCount: 5,
  pendingMessageTokens: 0,
  isReflecting: false,
  isObserving: false,
  isBufferingObservation: false,
  isBufferingReflection: false,
  lastBufferedAtTokens: 0,
  lastBufferedAtTime: null,
  config: {},
};

describe("Observational memory parity", () => {
  it("advertises observational-memory support", () => {
    expect(new SupabaseMemoryStorage(makeCtx().ctx).supportsObservationalMemory).toBe(true);
  });

  it("initialize upserts a fresh generation-0 record scoped by lookup key", async () => {
    const { ctx, rpcCalls } = makeCtx();
    const rec = await new SupabaseMemoryStorage(ctx).initializeObservationalMemory({
      threadId: "t1",
      resourceId: "r1",
      scope: "thread",
      config: { a: 1 },
    });
    expect(rec.originType).toBe("initial");
    expect(rec.generationCount).toBe(0);
    const call = rpcCalls.find((c) => c.name === "mastra_om_upsert");
    expect(call?.args.p_lookup_key).toBe("thread:t1");
    expect(call?.args.p_workspace_id).toBe("ws-1");
    expect(call?.args.p_record.generationCount).toBe(0);
  });

  it("getObservationalMemory maps the stored doc (dates revived)", async () => {
    const { ctx } = makeCtx(BASE_RECORD);
    const rec = await new SupabaseMemoryStorage(ctx).getObservationalMemory("t1", "r1");
    expect(rec?.id).toBe("om1");
    expect(rec?.generationCount).toBe(2);
    expect(rec?.createdAt).toBeInstanceOf(Date);
  });

  it("setReflectingFlag patches just the flag", async () => {
    const { ctx, rpcCalls } = makeCtx(BASE_RECORD);
    await new SupabaseMemoryStorage(ctx).setReflectingFlag("om1", true);
    expect(rpcCalls.find((c) => c.name === "mastra_om_patch")?.args.p_patch.isReflecting).toBe(
      true,
    );
  });

  it("updateActiveObservations accumulates totalTokensObserved", async () => {
    const { ctx, rpcCalls } = makeCtx(BASE_RECORD);
    await new SupabaseMemoryStorage(ctx).updateActiveObservations({
      id: "om1",
      observations: "new notes",
      tokenCount: 7,
      lastObservedAt: new Date("2026-02-01T00:00:00.000Z"),
      observedMessageIds: ["m1"],
    });
    const patch = rpcCalls.find((c) => c.name === "mastra_om_patch")?.args.p_patch;
    expect(patch.observationTokenCount).toBe(7);
    expect(patch.totalTokensObserved).toBe(17); // 10 prior + 7
    expect(patch.pendingMessageTokens).toBe(0);
    expect(patch.activeObservations).toBe("new notes");
  });

  it("swapBufferedToActive activates chunks and returns the breakdown", async () => {
    const record = {
      ...BASE_RECORD,
      bufferedObservationChunks: [
        {
          cycleId: "c1",
          observations: "o1",
          tokenCount: 3,
          messageIds: ["m1", "m2"],
          messageTokens: 100,
        },
        { cycleId: "c2", observations: "o2", tokenCount: 4, messageIds: ["m3"], messageTokens: 50 },
      ],
    };
    const { ctx, rpcCalls } = makeCtx(record);
    const res = await new SupabaseMemoryStorage(ctx).swapBufferedToActive({
      id: "om1",
      activationRatio: 1,
      messageTokensThreshold: 100,
      currentPendingTokens: 150,
    });
    expect(res.chunksActivated).toBe(2);
    expect(res.messageTokensActivated).toBe(150);
    expect(res.activatedMessageIds).toEqual(["m1", "m2", "m3"]);
    // all chunks consumed -> buffer cleared
    expect(
      rpcCalls.find((c) => c.name === "mastra_om_patch")?.args.p_patch.bufferedObservationChunks,
    ).toBeNull();
  });

  it("clearObservationalMemory deletes by lookup key", async () => {
    const { ctx, rpcCalls } = makeCtx();
    await new SupabaseMemoryStorage(ctx).clearObservationalMemory("t1", "r1");
    expect(rpcCalls.find((c) => c.name === "mastra_om_clear")?.args.p_lookup_key).toBe("thread:t1");
  });
});
