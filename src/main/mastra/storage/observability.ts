/**
 * Cloud Supabase AI-tracing storage adapter (pa6).
 *
 * Backs the Harness's MastraStorageExporter: persists generation trace SPANS to
 * cloud Supabase using the SAME secure pattern as chat memory — a per-run JWT
 * client (anon key + `Authorization: Bearer <jwt>`), writing through the SECURITY
 * DEFINER RPC `mastra_save_spans` (re-checks workspace membership, stamps
 * workspace_id from the validated scope, idempotent `ON CONFLICT DO NOTHING`).
 * No DB credential ships — identical to how messages are written.
 *
 * We advertise the exporter's `insert-only` strategy: each span is written ONCE
 * when it ends (full data present), so only createSpan/batchCreateSpans are
 * implemented and the exporter never calls batchUpdateSpans. The read/query
 * methods stay the base no-ops — traces are queried out-of-band via SQL/RLS
 * (the `read ws mastra ai spans` policy), not through this write-path adapter.
 */
import type {
  BatchCreateSpansArgs,
  CreateSpanArgs,
  ObservabilityStorageStrategy,
} from "@mastra/core/storage";
import { ObservabilityStorage } from "@mastra/core/storage";
import type { Json } from "../../../types/database";
import type { RunStorageContext } from "./context";

export class SupabaseObservabilityStorage extends ObservabilityStorage {
  private readonly ctx: RunStorageContext;

  constructor(ctx: RunStorageContext) {
    super();
    this.ctx = ctx;
  }

  // Tables are migration-managed; the JWT client has no DDL rights. No-op init.
  override async init(): Promise<void> {}

  // insert-only: spans arrive complete at span-end, so the exporter skips
  // batchUpdateSpans entirely — no realtime/update write path is needed.
  override get observabilityStrategy(): {
    preferred: ObservabilityStorageStrategy;
    supported: ObservabilityStorageStrategy[];
  } {
    return { preferred: "insert-only", supported: ["insert-only"] };
  }

  override async batchCreateSpans({ records }: BatchCreateSpansArgs): Promise<void> {
    if (!records || records.length === 0) return;
    // supabase-js JSON-serializes each record (Date -> ISO string); the RPC
    // parses the array and stamps workspace_id from our validated scope, so
    // trace ownership can't be spoofed by span payloads.
    const { error } = await this.ctx.client.rpc("mastra_save_spans", {
      p_spans: records as unknown as Json,
      p_workspace_id: this.ctx.workspaceId,
    });
    if (error) throw error;
  }

  override async createSpan({ span }: CreateSpanArgs): Promise<void> {
    await this.batchCreateSpans({ records: [span] });
  }
}
