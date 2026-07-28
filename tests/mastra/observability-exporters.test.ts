import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFiveMObservability,
  createProdObservability,
} from "../../src/main/mastra/observability";

/**
 * Exporter COMPOSITION (mnq). The risk this guards is accidental egress: telemetry
 * must leave the process only when someone deliberately configured a destination.
 * A self-hoster who sets nothing should get the console and nothing else; a managed
 * run should reach Mastra only via our proxy, never straight from the client.
 *
 * Asserted through the instance's own `getExporters()` / `getConfig()` rather than
 * by reaching into our factory, so these break if Mastra changes what it registers.
 */
const SERVICE = "fivem-generator";
const names = (obs: ReturnType<typeof createProdObservability>): string[] =>
  obs
    .getInstance(SERVICE)
    ?.getExporters()
    .map((e) => e.name) ?? [];

// Both token names the exporter accepts. MASTRA_CLOUD_ACCESS_TOKEN is the legacy
// one and must be cleared too, or these assertions pass for the wrong reason on a
// machine that happens to have it set.
const PLATFORM_ENV = [
  "MASTRA_PLATFORM_ACCESS_TOKEN",
  "MASTRA_CLOUD_ACCESS_TOKEN",
  "MASTRA_PROJECT_ID",
] as const;

describe("prod exporter composition", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of PLATFORM_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of PLATFORM_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("records to cloud storage only when no platform destination is configured", () => {
    const got = names(createProdObservability());
    expect(got).toEqual(["mastra-storage-exporter"]);
  });

  it("adds the platform exporter when a proxy url AND a user token are present", () => {
    const got = names(
      createProdObservability({
        proxyUrl: "https://example.supabase.co/functions/v1/observability-proxy",
        accessToken: "user-jwt",
      }),
    );
    expect(got).toContain("mastra-storage-exporter");
    expect(got).toContain("mastra-platform-exporter");
  });

  it("does NOT reach the platform when the proxy url is missing", () => {
    // A token alone must not cause the client to talk to Mastra directly — that is
    // the path that would require shipping a credential.
    const got = names(createProdObservability({ accessToken: "user-jwt" }));
    expect(got).toEqual(["mastra-storage-exporter"]);
  });

  it("does NOT reach the platform when the user token is missing", () => {
    const got = names(
      createProdObservability({
        proxyUrl: "https://example.supabase.co/functions/v1/observability-proxy",
      }),
    );
    expect(got).toEqual(["mastra-storage-exporter"]);
  });

  it.each(["MASTRA_PLATFORM_ACCESS_TOKEN", "MASTRA_CLOUD_ACCESS_TOKEN"])(
    "honours %s for a direct (non-proxied) platform export",
    (envName) => {
      // The exporter falls back through both names, so gating on only the newer one
      // silently disabled tracing on a machine where the legacy name was set and
      // perfectly usable. Cover both so that cannot regress.
      process.env[envName] = "operator-token";
      expect(names(createProdObservability())).toContain("mastra-platform-exporter");
    },
  );

  it("drops model_chunk spans in prod (per-event billing + DB writes)", () => {
    const cfg = createProdObservability().getInstance(SERVICE)?.getConfig();
    expect(cfg?.excludeSpanTypes).toContain("model_chunk");
  });
});

describe("dev / self-host exporter composition", () => {
  it("is console-only, and keeps chunk spans (local tracing is free)", () => {
    // Singleton: whatever the env was at first construction is what we assert. The
    // suite runs without MASTRA_PLATFORM_ACCESS_TOKEN set, so console-only is the
    // expected shape — the point is that no network exporter appears by default.
    const obs = createFiveMObservability();
    expect(names(obs)).toEqual(["tracing-console-exporter"]);
    expect(obs.getInstance(SERVICE)?.getConfig().excludeSpanTypes ?? []).toEqual([]);
  });

  it("is a singleton (a second instance would double-register exporters)", () => {
    expect(createFiveMObservability()).toBe(createFiveMObservability());
  });
});
