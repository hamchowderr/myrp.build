/**
 * Mastra AI tracing for the generation agent.
 *
 * Two sinks, chosen by run mode in ipc/chat.ts:
 *  - DEV/owner (`createFiveMObservability`): the zero-config {@link ConsoleExporter}
 *    — spans print to the process log, NO database and NO credential. Singleton
 *    (a second instance would double-register); safe because the console sink is
 *    stateless and dev is single-user.
 *  - PROD (`createProdObservability`): the {@link MastraStorageExporter}, which
 *    persists spans to the Harness's `observability` storage domain — our
 *    SupabaseObservabilityStorage (per-run JWT, RLS, SECURITY DEFINER RPC; no
 *    shipped credential). Created FRESH PER RUN: the exporter resolves its storage
 *    from `mastra.getStorage()` at init, and each run's storage is scoped to that
 *    run's tenant/JWT — a shared instance would bind to the first run's identity.
 *    If the `observability` domain is ever absent the exporter self-disables with
 *    a warning (framework safety net).
 *
 * The default `sensitiveDataFilter` redacts secrets (keys/tokens) before export.
 */
import { ConsoleExporter, MastraStorageExporter, Observability } from "@mastra/observability";

let devSingleton: Observability | undefined;

/** DEV/owner tracing: spans -> process log. No DB, no credential. */
export function createFiveMObservability(): Observability {
  if (!devSingleton) {
    devSingleton = new Observability({
      configs: {
        "fivem-generator": {
          serviceName: "fivem-generator",
          exporters: [new ConsoleExporter()],
        },
      },
    });
  }
  return devSingleton;
}

/**
 * PROD tracing: spans -> cloud Supabase via MastraStorageExporter. Fresh per run
 * (see file header). The exporter obtains the `observability` storage domain from
 * the Harness's storage at init; batching/retry/idempotency come from the exporter.
 */
export function createProdObservability(): Observability {
  return new Observability({
    configs: {
      "fivem-generator": {
        serviceName: "fivem-generator",
        exporters: [new MastraStorageExporter()],
      },
    },
  });
}
