import { Observability } from "@mastra/observability";
import { describe, expect, it } from "vitest";
import { createProdObservability } from "../../src/main/mastra/observability";
import type { RunStorageContext } from "../../src/main/mastra/storage/context";
import { SupabaseObservabilityStorage } from "../../src/main/mastra/storage/observability";
import type { RunSupabaseClient } from "../../src/main/mastra/storage/supabase-client";

/**
 * The cloud AI-tracing sink (pa6). The adapter writes spans through the
 * SECURITY DEFINER RPC mastra_save_spans, scoped to the ctx workspace — never
 * from the span payload. Here we stub the run client and assert the right RPC +
 * args are issued, plus the prod Observability factory shape.
 */

interface RpcCall {
  name: string;
  args: any;
}

function makeCtx(): { ctx: RunStorageContext; rpcCalls: RpcCall[] } {
  const rpcCalls: RpcCall[] = [];
  const client = {
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

// A minimal span record — the adapter forwards it opaquely to the RPC.
function span(spanId: string): any {
  return {
    traceId: "t1",
    spanId,
    name: "agent_run",
    spanType: "agent_run",
    isEvent: false,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("SupabaseObservabilityStorage", () => {
  it("advertises the insert-only strategy (spans written once, no updates)", () => {
    const s = new SupabaseObservabilityStorage(makeCtx().ctx);
    expect(s.observabilityStrategy.preferred).toBe("insert-only");
    expect(s.observabilityStrategy.supported).toEqual(["insert-only"]);
  });

  it("batchCreateSpans issues mastra_save_spans with the records + ctx workspace", async () => {
    const { ctx, rpcCalls } = makeCtx();
    await new SupabaseObservabilityStorage(ctx).batchCreateSpans({
      records: [span("s1"), span("s2")],
    });
    const call = rpcCalls.find((c) => c.name === "mastra_save_spans");
    expect(call?.args.p_workspace_id).toBe("ws-1");
    expect(call?.args.p_spans).toHaveLength(2);
    expect(call?.args.p_spans[0].spanId).toBe("s1");
  });

  it("createSpan delegates to a single-record batch insert", async () => {
    const { ctx, rpcCalls } = makeCtx();
    await new SupabaseObservabilityStorage(ctx).createSpan({ span: span("only") });
    const call = rpcCalls.find((c) => c.name === "mastra_save_spans");
    expect(call?.args.p_spans).toHaveLength(1);
    expect(call?.args.p_spans[0].spanId).toBe("only");
  });

  it("is a no-op for an empty batch (no RPC)", async () => {
    const { ctx, rpcCalls } = makeCtx();
    await new SupabaseObservabilityStorage(ctx).batchCreateSpans({ records: [] });
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("createProdObservability", () => {
  it("builds an Observability with the fivem-generator instance registered", () => {
    const obs = createProdObservability();
    expect(obs).toBeInstanceOf(Observability);
    expect(obs.hasInstance("fivem-generator")).toBe(true);
  });

  it("returns a FRESH instance each call (per-run tenant/JWT binding)", () => {
    expect(createProdObservability()).not.toBe(createProdObservability());
  });
});
