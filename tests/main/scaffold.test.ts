import { describe, expect, it } from "vitest";
import { sanitizeServerFolderName, starterServerCfg } from "../../src/main/scaffold";

// m8se.4 — the pure scaffold helpers (the I/O + ox download path needs a real
// filesystem/network, exercised manually).

describe("sanitizeServerFolderName", () => {
  it("strips path-illegal characters and collapses whitespace", () => {
    expect(sanitizeServerFolderName("My RP: Server?/<x>")).toBe("My-RP-Serverx");
    expect(sanitizeServerFolderName("  spaced   name  ")).toBe("spaced-name");
    expect(sanitizeServerFolderName("a\\b/c")).toBe("abc");
  });

  it("falls back to a default for empty/garbage input", () => {
    expect(sanitizeServerFolderName("")).toBe("fivem-server");
    expect(sanitizeServerFolderName("   ")).toBe("fivem-server");
    expect(sanitizeServerFolderName("///")).toBe("fivem-server");
  });
});

describe("starterServerCfg", () => {
  it("wires the ox base in load order and embeds the hostname", () => {
    const cfg = starterServerCfg("Test RP");
    expect(cfg).toContain('sv_hostname "Test RP"');
    const order = ["ox_lib", "oxmysql", "ox_core", "ox_inventory"].map((r) =>
      cfg.indexOf(`ensure ${r}`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b)); // strictly increasing = correct load order
  });

  it("never puts a ';' in a comment line (FiveM truncates on ';')", () => {
    for (const line of starterServerCfg("x").split("\n")) {
      if (line.trimStart().startsWith("#")) expect(line).not.toContain(";");
    }
  });
});
