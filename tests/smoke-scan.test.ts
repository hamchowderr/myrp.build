/**
 * Unit tests for the deploy smoke-test console scanner.
 * Pure logic — no server, no RCON, no credits.
 */
import { describe, expect, it } from "vitest";
import type { ConsoleEntry } from "../src/main/fxdk/session";
import { LOAD_ERROR_PATTERNS, scanConsoleForLoadErrors } from "../src/main/smoke-scan";

let n = 0;
const lines = (...texts: string[]): ConsoleEntry[] =>
  texts.map((text) => ({ id: `e${n++}`, source: "stdout", text, timestamp: Date.now() }));

const FIVEM_RED = String.fromCharCode(94, 49); // "^1"
const FIVEM_WHITE = String.fromCharCode(94, 55); // "^7"
const ANSI_RED = `${String.fromCharCode(27)}[31m`; // ESC[31m
const ANSI_RESET = `${String.fromCharCode(27)}[0m`; // ESC[0m

describe("scanConsoleForLoadErrors", () => {
  it("passes a clean load and confirms the start", () => {
    const r = scanConsoleForLoadErrors(
      lines("Started resource my-resource", "[script:my-resource] ready"),
      "my-resource",
    );
    expect(r.loadSuccess).toBe(true);
    expect(r.startedConfirmed).toBe(true);
    expect(r.loadError).toBeUndefined();
  });

  it("passes with no output but no start confirmation", () => {
    const r = scanConsoleForLoadErrors(lines("some unrelated line"), "my-resource");
    expect(r.loadSuccess).toBe(true);
    expect(r.startedConfirmed).toBe(false);
  });

  it("detects a Lua script error", () => {
    const r = scanConsoleForLoadErrors(
      lines(
        "Started resource my-resource",
        "SCRIPT ERROR: @my-resource/server.lua:12: attempt to index nil",
      ),
      "my-resource",
    );
    expect(r.loadSuccess).toBe(false);
    expect(r.loadError).toContain("Lua script error");
    expect(r.snippet?.length).toBeGreaterThan(0);
  });

  it("detects a missing dependency", () => {
    const r = scanConsoleForLoadErrors(
      lines(
        "Couldn't start resource my-resource.",
        "Could not find dependency ox_lib for resource my-resource.",
      ),
      "my-resource",
    );
    expect(r.loadSuccess).toBe(false);
    expect(r.loadError).toMatch(/resource failed to start|missing dependency/);
  });

  it("strips FiveM color codes before matching", () => {
    const r = scanConsoleForLoadErrors(
      lines(`${FIVEM_RED}SCRIPT ERROR:${FIVEM_WHITE} bad things`),
      "my-resource",
    );
    expect(r.loadSuccess).toBe(false);
    expect(r.loadError).toContain("SCRIPT ERROR");
    expect(r.loadError).not.toContain(FIVEM_RED);
  });

  it("strips ANSI color codes before matching", () => {
    const r = scanConsoleForLoadErrors(
      lines(`${ANSI_RED}SCRIPT ERROR: boom${ANSI_RESET}`),
      "my-resource",
    );
    expect(r.loadSuccess).toBe(false);
    expect(r.loadError).toContain("SCRIPT ERROR");
    expect(r.loadError).not.toContain(ANSI_RED);
  });

  it("detects a generic [ERROR] log line", () => {
    const r = scanConsoleForLoadErrors(lines("  [ERROR] failed parsing manifest"), "my-resource");
    expect(r.loadSuccess).toBe(false);
  });

  it("does not break on a resource name with regex specials", () => {
    const r = scanConsoleForLoadErrors(lines("Started resource my.resource+v2"), "my.resource+v2");
    expect(r.startedConfirmed).toBe(true);
    expect(r.loadSuccess).toBe(true);
  });

  it("ships a non-empty pattern library", () => {
    expect(LOAD_ERROR_PATTERNS.length).toBeGreaterThanOrEqual(5);
  });
});
