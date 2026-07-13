import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFiveMHarness, fivemToolCategory } from "../../src/main/mastra/harness";
import { createFiveMWorkspace } from "../../src/main/mastra/workspace";
import { setupAimock } from "../setup/aimock";

// OPENAI_BASE_URL so createFiveMAgent's gateway model resolves to AIMock.
setupAimock();

describe("fivemToolCategory (HITL permission categories)", () => {
  it("marks live-server + command tools as execute", () => {
    for (const t of [
      "deploy_resource",
      "install_resource",
      "import_schema",
      "start_server",
      "restart_server",
      "mastra_workspace_execute_command",
    ]) {
      expect(fivemToolCategory(t)).toBe("execute");
    }
  });

  it("marks file mutations as edit and reads/skills as read", () => {
    expect(fivemToolCategory("mastra_workspace_write_file")).toBe("edit");
    expect(fivemToolCategory("mastra_workspace_delete")).toBe("edit");
    expect(fivemToolCategory("mastra_workspace_read_file")).toBe("read");
    expect(fivemToolCategory("validate_resource")).toBe("read");
    expect(fivemToolCategory("server_status")).toBe("read");
    expect(fivemToolCategory("skill_search")).toBe("read");
  });

  it("returns null for unmapped tools (→ other)", () => {
    expect(fivemToolCategory("subagent")).toBeNull();
    expect(fivemToolCategory("ask_user")).toBeNull();
  });
});

/**
 * Proves the REAL Harness configuration (supervisor +
 * 7 isolated subagent defs + composite storage + workspace + a generate mode)
 * constructs, init()s, and opens a session. This is the additive de-risk before
 * the live-path rewire; the Harness is NOT yet wired into chat.ts.
 */
describe("createFiveMHarness factory", () => {
  let root: string;
  let harness: ReturnType<typeof createFiveMHarness>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fivem-harness-"));
    const workspace = createFiveMWorkspace(root, { interactive: false });
    await workspace.init();
    const storage = new MastraCompositeStore({
      id: "harness-factory-test",
      domains: {
        memory: new InMemoryStore().stores.memory,
        workflows: new InMemoryStore().stores.workflows,
      },
    });
    harness = createFiveMHarness(workspace, { storage });
    await harness.init();
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  it("exposes the generate mode", () => {
    expect(harness.listModes().map((m) => m.id)).toContain("generate");
  });

  it("opens a session with a workspace and supports thread create", async () => {
    const session = await harness.createSession({ resourceId: "ws_t__srv_t" });
    const before = (await session.thread.list()).length;
    const t = await session.thread.create({ title: "smoke" });
    expect(t.id).toBeTruthy();
    expect(await session.thread.list()).toHaveLength(before + 1);
  });
});
