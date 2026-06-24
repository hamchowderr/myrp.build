import { describe, expect, it } from "vitest";
import type { RunStorageContext } from "../../src/main/mastra/storage/context";
import { SupabaseMemoryStorage } from "../../src/main/mastra/storage/memory";
import type { RunSupabaseClient } from "../../src/main/mastra/storage/supabase-client";

// fivem-studio-liza: SupabaseMemoryStorage.cloneThread is our cloud implementation
// of Mastra's native clone primitive (Memory.cloneThread() delegates to it). It is
// composed from existing primitives — RLS reads + SECURITY DEFINER save RPCs — so
// here we stub the run client and assert it reproduces @mastra/pg MemoryPG semantics:
// clone metadata, "Clone of <title>" default, remapped message ids + messageIdMap.

const SOURCE_THREAD = {
  id: "src-thread",
  resource_id: "ws_a__srv_b",
  title: "My Chat",
  metadata: { foo: "bar" },
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const MESSAGE_ROWS = [
  {
    id: "m1",
    thread_id: "src-thread",
    resource_id: "ws_a__srv_b",
    role: "user",
    type: "v2",
    content: { format: 2, parts: [{ type: "text", text: "hello" }] },
    created_at: "2026-01-01T00:00:01.000Z",
  },
  {
    id: "m2",
    thread_id: "src-thread",
    resource_id: "ws_a__srv_b",
    role: "assistant",
    type: "v2",
    content: { format: 2, parts: [{ type: "text", text: "hi there" }] },
    created_at: "2026-01-01T00:00:02.000Z",
  },
];

interface RpcCall {
  name: string;
  args: any;
}

function makeCtx(): { ctx: RunStorageContext; rpcCalls: RpcCall[] } {
  const rpcCalls: RpcCall[] = [];

  function builder(table: string) {
    const filters: Record<string, unknown> = {};
    const rows = table === "mastra_messages" ? MESSAGE_ROWS : [];
    const b: any = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return b;
      },
      in: () => b,
      gte: () => b,
      lte: () => b,
      // Terminal reads resolve native Promises (the messages-read path awaits these).
      limit: () => Promise.resolve({ data: [...rows].reverse(), error: null }),
      order: () => {
        const p = Promise.resolve({ data: rows, error: null }) as Promise<unknown> & {
          limit: () => Promise<unknown>;
        };
        p.limit = () => Promise.resolve({ data: [...rows].reverse(), error: null });
        return p;
      },
      maybeSingle: async () => {
        if (table === "mastra_threads") {
          return { data: filters.id === SOURCE_THREAD.id ? SOURCE_THREAD : null, error: null };
        }
        return { data: null, error: null };
      },
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

describe("SupabaseMemoryStorage.cloneThread (fivem-studio-liza)", () => {
  it("clones a thread with native Mastra semantics", async () => {
    const { ctx, rpcCalls } = makeCtx();
    const store = new SupabaseMemoryStorage(ctx);

    const out = await store.cloneThread({
      sourceThreadId: "src-thread",
      newThreadId: "new-thread",
    });

    // New thread inherits resourceId + gets the "Clone of <title>" default + clone metadata.
    expect(out.thread.id).toBe("new-thread");
    expect(out.thread.resourceId).toBe("ws_a__srv_b");
    expect(out.thread.title).toBe("Clone of My Chat");
    const meta = out.thread.metadata as {
      clone?: { sourceThreadId?: string; lastMessageId?: string };
    };
    expect(meta.clone?.sourceThreadId).toBe("src-thread");
    expect(meta.clone?.lastMessageId).toBe("m2");

    // Messages copied with NEW ids, pointing at the new thread, with a full id map.
    expect(out.clonedMessages).toHaveLength(2);
    expect(Object.keys(out.messageIdMap ?? {})).toEqual(["m1", "m2"]);
    for (const m of out.clonedMessages) {
      expect(m.threadId).toBe("new-thread");
      expect(["m1", "m2"]).not.toContain(m.id);
    }

    // Writes went through the SECURITY DEFINER RPCs (not raw SQL).
    const saveThread = rpcCalls.find((c) => c.name === "mastra_save_thread");
    expect(saveThread?.args.p_title).toBe("Clone of My Chat");
    expect(saveThread?.args.p_metadata.clone.sourceThreadId).toBe("src-thread");
    const saveMsgs = rpcCalls.find((c) => c.name === "mastra_save_messages");
    expect(saveMsgs?.args.p_messages).toHaveLength(2);
  });

  it("throws when the source thread does not exist", async () => {
    const { ctx } = makeCtx();
    const store = new SupabaseMemoryStorage(ctx);
    await expect(
      store.cloneThread({ sourceThreadId: "missing", newThreadId: "x" }),
    ).rejects.toThrow(/not found/);
  });
});
