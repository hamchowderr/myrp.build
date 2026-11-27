/**
 * Sign-in loopback failure feedback.
 *
 * Found on the FIRST real sign-in against an installed prod build (2026-07-30).
 * It took the owner two attempts:
 *   17:31:38  loopback ready
 *   17:36:38  loopback timed out (no callback within 5m)   <- attempt 1, expired
 *   17:38:46  loopback ready
 *   17:38:56  captured OAuth code                          <- attempt 2, 10s
 *
 * Attempt one did not fail, it EXPIRED — and said nothing. `stopSignInServer()`
 * closed the socket and the renderer was never told, so the browser landed on
 * connection-refused while the app sat on `busy` forever. On launch day every
 * user is doing the slow first-time Discord login that attempt one represents.
 *
 * These tests pin the two properties that fix it, without booting Electron:
 * the timeout is long enough for a real first sign-in, and every path that ends
 * WITHOUT a code notifies the renderer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const AUTH_SRC = readFileSync(join(__dirname, "../../src/main/bootstrap/auth.ts"), "utf-8");

describe("sign-in loopback timeout", () => {
  it("waits long enough for a genuine first-time Discord login", () => {
    const m = AUTH_SRC.match(/SIGNIN_TIMEOUT_MS\s*=\s*(\d+)\s*\*\s*60_000/);
    expect(m, "SIGNIN_TIMEOUT_MS should be declared in minutes").toBeTruthy();
    const minutes = Number(m?.[1]);
    // 5 minutes demonstrably expired on a real first sign-in. Anything at or
    // below that reintroduces the bug.
    expect(minutes).toBeGreaterThan(5);
  });

  it("uses the named constant for the timer, not a bare literal", () => {
    // A second hard-coded duration would drift from the constant silently.
    expect(AUTH_SRC).toMatch(/setTimeout\([\s\S]{0,400}?SIGNIN_TIMEOUT_MS\)/);
    expect(AUTH_SRC).not.toMatch(/}\s*,\s*5\s*\*\s*60_000\)/);
  });
});

describe("sign-in failure is surfaced to the renderer", () => {
  it("notifies on timeout", () => {
    // The expiry path must do more than log — that silence WAS the bug.
    const timer = AUTH_SRC.match(/setTimeout\(\(\) => \{([\s\S]*?)\}, SIGNIN_TIMEOUT_MS\)/);
    expect(timer, "timeout handler not found").toBeTruthy();
    expect(timer?.[1]).toContain("notifySignInFailed");
  });

  it("notifies when the callback arrives without a code (Discord denied)", () => {
    expect(AUTH_SRC).toMatch(/loopback hit without a code[\s\S]{0,300}?notifySignInFailed/);
  });

  it("sends on a channel the preload bridge actually forwards", () => {
    expect(AUTH_SRC).toContain('"auth:signin-failed"');
    const preload = readFileSync(join(__dirname, "../../src/preload/index.ts"), "utf-8");
    expect(preload).toContain('ipcRenderer.on("auth:signin-failed"');
    expect(preload).toContain("onAuthSignInFailed");
  });

  it("is declared in BOTH window.api declaration files", () => {
    // Project rule: src/preload/index.d.ts and src/renderer/src/env.d.ts must stay
    // in sync. A handler present in one and missing from the other typechecks in
    // one target and fails in the other.
    for (const rel of ["../../src/preload/index.d.ts", "../../src/renderer/src/env.d.ts"]) {
      expect(readFileSync(join(__dirname, rel), "utf-8"), rel).toContain("onAuthSignInFailed");
    }
  });

  it("the sign-in screen clears busy and shows a message", () => {
    const ui = readFileSync(join(__dirname, "../../src/renderer/src/auth/CustomAuth.tsx"), "utf-8");
    expect(ui).toContain("onAuthSignInFailed");
    // Leaving busy=true would keep the spinner forever — the original symptom.
    expect(ui).toMatch(/onAuthSignInFailed\([\s\S]{0,800}?busy:\s*false/);
    expect(ui).toMatch(/onAuthSignInFailed\([\s\S]{0,800}?error:/);
  });
});
