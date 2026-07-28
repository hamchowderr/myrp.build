/**
 * Mastra AI tracing for the generation agent.
 *
 * Exporters are assembled per run mode. All of them are first-party Mastra
 * exporters — this app is built on Mastra deliberately, so a self-hoster gets the
 * same wiring the owner has and can point it at their own account.
 *
 *  - DEV / self-host (`createFiveMObservability`): {@link ConsoleExporter} — spans
 *    to the process log, no DB and no credential. Plus {@link MastraPlatformExporter}
 *    when `MASTRA_PLATFORM_ACCESS_TOKEN` is set, so anyone running from source can
 *    send traces to THEIR OWN Mastra Observe project. Singleton: the console sink is
 *    stateless, dev is single-user, and env can't change mid-process.
 *
 *  - PROD (`createProdObservability`): {@link MastraStorageExporter} into the
 *    Harness's `observability` storage domain — our SupabaseObservabilityStorage
 *    (per-run JWT, RLS, SECURITY DEFINER RPC). Plus the platform exporter pointed at
 *    our `observability-proxy` edge function when one is configured. Created FRESH
 *    PER RUN: the storage exporter resolves its domain from `mastra.getStorage()` at
 *    init and each run's storage is scoped to that run's tenant/JWT, so a shared
 *    instance would bind to the first run's identity.
 *
 * NO CREDENTIAL SHIPS. On the managed path the bearer is the user's OWN per-run
 * Supabase JWT; the edge function verifies it and swaps in the real platform token
 * server-side — the same trick `inference-proxy` uses for the gateway key. A
 * self-hoster supplies their own token via env and never touches our proxy.
 *
 * The default `sensitiveDataFilter` redacts secrets before any span is exported.
 */
import { type ObservabilityExporter, SpanType } from "@mastra/core/observability";
import {
  ConsoleExporter,
  MastraPlatformExporter,
  MastraStorageExporter,
  Observability,
} from "@mastra/observability";

/** Options for the managed (signed-in) trace path. */
export interface ProdObservabilityOptions {
  /**
   * Base URL of the deployed `observability-proxy` edge function, e.g.
   * `https://<ref>.supabase.co/functions/v1/observability-proxy`. Omit to skip the
   * platform exporter and record spans to cloud storage only.
   */
  proxyUrl?: string;
  /**
   * The user's per-run Supabase JWT — what the proxy verifies. Not a secret we own.
   *
   * Sent as `Authorization: Bearer`, which is the only header the exporter lets us
   * set — it takes no custom-header option. That is sufficient: Supabase Edge
   * Functions authenticate on `Authorization` (the `apikey` header the inference
   * path passes is a Kong/PostgREST concern, not a function one), and with
   * `verify_jwt` on, Supabase rejects unauthenticated posts before our code runs.
   */
  accessToken?: string;
}

/**
 * Span types dropped before they reach ANY exporter.
 *
 * `MODEL_CHUNK` is one span per streamed chunk — the dominant volume in a
 * generation, and worthless once the parent generation span records the result.
 * Mastra's platform billing is per event, so this is a cost control, not tidiness.
 * Dropping here (rather than in a single exporter) also saves the DB writes.
 */
const HIGH_VOLUME_SPANS = [SpanType.MODEL_CHUNK];

const SERVICE = "fivem-generator";

/**
 * The platform exporter, or undefined when nothing is configured.
 *
 * `tracesEndpoint` takes a full publish URL — Mastra derives the other signals
 * (logs/metrics/scores/feedback) from it by swapping the suffix — which is what
 * lets it point at an edge-function subpath rather than a bare origin.
 */
function platformExporter(opts?: ProdObservabilityOptions): MastraPlatformExporter | undefined {
  if (opts?.proxyUrl && opts.accessToken) {
    return new MastraPlatformExporter({
      tracesEndpoint: `${opts.proxyUrl.replace(/\/+$/, "")}/spans/publish`,
      accessToken: opts.accessToken,
    });
  }
  // Self-host / owner: the operator's own project, straight to Mastra. The exporter
  // reads MASTRA_PLATFORM_ACCESS_TOKEN itself; we gate on it so an unconfigured
  // install carries no disabled exporter at all.
  if (process.env.MASTRA_PLATFORM_ACCESS_TOKEN) {
    return new MastraPlatformExporter({
      projectId: process.env.MASTRA_PLATFORM_PROJECT_ID,
    });
  }
  return undefined;
}

function config(exporters: ObservabilityExporter[], excludeHighVolume: boolean) {
  return {
    configs: {
      [SERVICE]: {
        serviceName: SERVICE,
        exporters,
        ...(excludeHighVolume ? { excludeSpanTypes: HIGH_VOLUME_SPANS } : {}),
      },
    },
  };
}

let devSingleton: Observability | undefined;

/**
 * DEV / self-host tracing: spans -> process log, and -> the operator's own Mastra
 * Observe project when they've set `MASTRA_PLATFORM_ACCESS_TOKEN`. Never routes
 * through our proxy. Chunk spans are kept here — locally they're free and useful.
 */
export function createFiveMObservability(): Observability {
  if (!devSingleton) {
    const platform = platformExporter();
    devSingleton = new Observability(
      config(platform ? [new ConsoleExporter(), platform] : [new ConsoleExporter()], false),
    );
  }
  return devSingleton;
}

/**
 * PROD tracing: spans -> the tenant's cloud Supabase, plus Mastra Observe via the
 * proxy when configured. Fresh per run (see file header).
 */
export function createProdObservability(opts?: ProdObservabilityOptions): Observability {
  const platform = platformExporter(opts);
  const exporters = platform
    ? [new MastraStorageExporter(), platform]
    : [new MastraStorageExporter()];
  return new Observability(config(exporters, true));
}
