import { Observability } from "@mastra/observability";
import { describe, expect, it } from "vitest";
import { createFiveMObservability } from "../../src/main/mastra/observability";

/**
 * The Mastra AI tracing entrypoint. Verifies the previously
 * unused @mastra/observability is now wired: a real Observability with the
 * fivem-generator instance registered, returned as a memoized singleton (a second
 * instance would double-register exporters).
 */
describe("createFiveMObservability", () => {
  it("builds an Observability with the fivem-generator instance registered", () => {
    const obs = createFiveMObservability();
    expect(obs).toBeInstanceOf(Observability);
    expect(obs.hasInstance("fivem-generator")).toBe(true);
  });

  it("returns the same singleton on repeated calls", () => {
    expect(createFiveMObservability()).toBe(createFiveMObservability());
  });
});
