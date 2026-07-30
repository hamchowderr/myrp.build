/**
 * myrp-build-3yw — harness error events must arrive READABLE.
 *
 * A FULL-lane run failed with `{"type":"error","error":{}}` in the renderer and
 * nothing in the main log, which made the failure impossible to diagnose (and
 * blocked myrp-build-9h1, since you cannot search destroyed text for a phrase).
 *
 * The first test is the one that matters: it reproduces the ACTUAL mechanism —
 * an Error nested in a plain object loses message/name/stack when cloned,
 * because they are non-enumerable own properties.
 */
import { describe, expect, it } from "vitest";
import { readableError } from "../../src/main/ipc/harness-error";

/** Stand-in for Electron's structured clone across the IPC boundary. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** The normalised payload of an event, however it was shaped going in. */
function payload(event: unknown): { message: string; name?: string; stack?: string } {
  return (event as { error: { message: string; name?: string; stack?: string } }).error;
}

describe("readableError", () => {
  it("survives the structured clone that destroyed the original payload", () => {
    const raw = { type: "error", error: new Error("gateway exploded") };

    // POSITIVE CONTROL: prove the bug is real and this test can see it.
    // Cloning the RAW event loses everything — this is the observed `{}`.
    expect(Object.keys(payload(clone(raw)))).toHaveLength(0);

    // After normalising, the message survives the same clone.
    const after = payload(clone(readableError(raw)));
    expect(after.message).toBe("gateway exploded");
    expect(after.stack).toBeTruthy();
  });

  it("keeps a string payload as a readable message", () => {
    const out = readableError({ type: "error", error: "Step budget reached (30 model calls)" });
    expect(payload(out).message).toContain("Step budget reached");
  });

  it("unwraps a nested provider error", () => {
    const out = readableError({ type: "error", error: { error: { message: "model refused" } } });
    expect(payload(out).message).toBe("model refused");
  });

  it("says so explicitly when the payload is empty, instead of forwarding {}", () => {
    const out = readableError({ type: "error", error: {} });
    expect(payload(out).message).toMatch(/unreadable/i);
    // The whole point: never hand the UI something with no information in it.
    expect(payload(out).message.length).toBeGreaterThan(10);
  });

  it("reports a missing payload rather than throwing", () => {
    expect(payload(readableError({ type: "error" })).message).toMatch(/unknown error/i);
  });

  it("keeps statusCode and type — the fields that name a gateway failure", () => {
    // The real case: a Vercel AI Gateway failure. The SDK throws a DIFFERENT
    // class per cause (GatewayRateLimitError at 429 vs GatewayResponseError for a
    // malformed upstream reply), and statusCode/type are what distinguish "we got
    // rate limited" from "the provider fell over". A whitelist of
    // message/name/stack/code silently dropped both, leaving a failed generation
    // undiagnosable.
    const err = Object.assign(new Error("Invalid error response format"), {
      statusCode: 502,
      type: "response_error",
    });
    const out = payload(clone(readableError({ type: "error", error: err }))) as unknown as {
      message: string;
      detail?: Record<string, unknown>;
    };
    expect(out.detail?.statusCode).toBe(502);
    expect(out.detail?.type).toBe("response_error");
  });

  it("bounds a huge scalar field instead of forwarding it whole", () => {
    const err = Object.assign(new Error("boom"), { body: "x".repeat(5000) });
    const out = payload(readableError({ type: "error", error: err })) as unknown as {
      detail?: Record<string, string>;
    };
    expect(out.detail?.body.length).toBeLessThan(600);
  });

  it("passes non-error events through untouched", () => {
    // This sits on the hot path for every event of every run — it must not
    // rewrite or reallocate ordinary traffic.
    const evt = { type: "tool_start", toolName: "write_file" };
    expect(readableError(evt)).toBe(evt);
  });
});
