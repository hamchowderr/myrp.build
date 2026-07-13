import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "@mastra/core/workspace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFiveMWorkspace } from "../../src/main/mastra/workspace";

/**
 * Unit tests for the workspace tools the agent relies on — filesystem
 * read/write/list/exists/stat, BM25 search, and sandbox command execution. No
 * LLM involved, so no AIMock; this is the foundation the generation loop sits on.
 */
describe("FiveM workspace tools", () => {
  let root: string;
  let ws: Workspace;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fivem-ws-unit-"));
    mkdirSync(join(root, "[local]", "demo"), { recursive: true });
    writeFileSync(
      join(root, "[local]", "demo", "fxmanifest.lua"),
      "fx_version 'cerulean'\nshared_script '@ox_lib/init.lua'\n",
    );
    // Headless so writes don't require approval.
    ws = createFiveMWorkspace(root, { interactive: false });
    await ws.init();
  });

  afterAll(async () => {
    await ws.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  it("writes, reads back, and stats files", async () => {
    const fs = ws.filesystem!;
    await fs.writeFile("[local]/demo/server.lua", "print('ox')\n");

    expect(await fs.exists("[local]/demo/server.lua")).toBe(true);
    const content = await fs.readFile("[local]/demo/server.lua");
    expect(typeof content === "string" ? content : content.toString()).toContain("ox");

    const stat = await fs.stat("[local]/demo/server.lua");
    expect(stat.type).toBe("file");
  });

  it("lists directory entries", async () => {
    const entries = await ws.filesystem?.readdir("[local]/demo");
    const names = entries.map((e) => e.name);
    expect(names).toContain("fxmanifest.lua");
  });

  it("finds content via BM25 search", async () => {
    const results = await ws.search("ox_lib", { topK: 5 });
    expect(results.length).toBeGreaterThan(0);
  });

  it("executes a sandbox command", async () => {
    // Quote-free command — the local sandbox re-quotes args through the OS
    // shell, so `node -e "..."` mangles inner quotes on Windows. `--version`
    // is enough to prove command execution + stdout capture + exit code.
    const result = await ws.sandbox?.executeCommand?.("node", ["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/v\d+\./);
  });
});
