/**
 * Mastra AI tracing for the generation agent.
 *
 * `@mastra/observability` was a declared-but-unused dependency; this wires it
 * into the Harness so agent + tool runs produce trace spans. The exporter is the
 * zero-config {@link ConsoleExporter}: spans print to the process log — NO database
 * and NO credential, which is mandatory here (the client ships none). The default
 * `sensitiveDataFilter` redacts secrets (keys/tokens) before any span is exported.
 *
 * Scope: this is the DEV/owner tracing sink (the live path attaches it only under
 * __DEV_BYPASS__). A persistent, queryable PROD sink (Mastra Platform exporter, or
 * a cloud storage domain) is a deliberate follow-up — it needs a sink decision and
 * must honor the no-shipped-creds rule.
 */
import { ConsoleExporter, Observability } from "@mastra/observability";

let singleton: Observability | undefined;

/**
 * The shared FiveM tracing entrypoint (lazily constructed once — a second
 * instance would double-register exporters). Pass the return value to the Harness
 * `observability` option.
 */
export function createFiveMObservability(): Observability {
  if (!singleton) {
    singleton = new Observability({
      configs: {
        "fivem-generator": {
          serviceName: "fivem-generator",
          exporters: [new ConsoleExporter()],
        },
      },
    });
  }
  return singleton;
}
