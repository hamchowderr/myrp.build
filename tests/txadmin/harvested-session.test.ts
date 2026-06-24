/**
 * Unit coverage for the txAdmin harvested-session cache (fivem-studio-dt2).
 *
 * Deterministic — exercises only the in-memory cache contract (set / has /
 * clear). The end-to-end behaviour (real Cfx.re login in the webview, cookie
 * harvest from the Electron partition, REST writes with no stored password) is
 * NOT exercised here — that needs a live txAdmin + a Cfx.re account and is
 * tracked in the manual live-verify issue.
 */

import { describe, expect, it } from "vitest";
import {
  clearHarvestedSession,
  hasHarvestedSession,
  setHarvestedSession,
} from "../../src/main/txadmin/client";

describe("harvested session cache", () => {
  const base = "http://127.0.0.1:40120";
  const session = { cookie: "sess=abc; sess.sig=def", csrfToken: "tok123" };

  it("starts with no harvested session", () => {
    expect(hasHarvestedSession(base)).toBe(false);
  });

  it("reports an injected session as active", () => {
    setHarvestedSession(base, session);
    expect(hasHarvestedSession(base)).toBe(true);
  });

  it("normalises a trailing slash to the same key", () => {
    setHarvestedSession(`${base}/`, session);
    expect(hasHarvestedSession(base)).toBe(true);
    expect(hasHarvestedSession(`${base}/`)).toBe(true);
  });

  it("clears the session on sign-out", () => {
    setHarvestedSession(base, session);
    clearHarvestedSession(base);
    expect(hasHarvestedSession(base)).toBe(false);
  });

  it("scopes sessions per baseUrl", () => {
    const other = "http://127.0.0.1:40121";
    clearHarvestedSession(base);
    clearHarvestedSession(other);
    setHarvestedSession(base, session);
    expect(hasHarvestedSession(base)).toBe(true);
    expect(hasHarvestedSession(other)).toBe(false);
  });
});
