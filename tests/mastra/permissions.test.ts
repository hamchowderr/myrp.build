import type { Session } from "@mastra/core/agent-controller";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { describe, expect, it } from "vitest";
import { applyFiveMPermissions } from "../../src/main/mastra/permissions";

/**
 * FiveM HITL permission policy (security hardening).
 * A minimal fake Session records the policies applyFiveMPermissions sets, so we
 * can assert the contract — especially the SECURE DEFAULT (shell/delete/kill gate
 * unless explicitly opted out) — without a live Harness run.
 */
function fakeSession() {
  const tools: Record<string, string> = {};
  const categories: Record<string, string> = {};
  const session = {
    permissions: {
      setForTool: async ({ toolName, policy }: { toolName: string; policy: string }) => {
        tools[toolName] = policy;
      },
      setForCategory: async ({ category, policy }: { category: string; policy: string }) => {
        categories[category] = policy;
      },
    },
  } as unknown as Session;
  return { tools, categories, session };
}

describe("applyFiveMPermissions — FiveM HITL policy", () => {
  it("gates shell/delete/kill BY DEFAULT when requireApproval is unset (secure default)", async () => {
    const f = fakeSession();
    await applyFiveMPermissions(f.session);
    expect(f.tools[WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]).toBe("ask");
    expect(f.tools[WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS]).toBe("ask");
    expect(f.tools[WORKSPACE_TOOLS.FILESYSTEM.DELETE]).toBe("ask");
  });

  it("ungates shell/delete ONLY on an explicit opt-out (requireApproval:false)", async () => {
    const f = fakeSession();
    await applyFiveMPermissions(f.session, { requireApproval: false });
    expect(f.tools[WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]).toBe("allow");
    expect(f.tools[WORKSPACE_TOOLS.FILESYSTEM.DELETE]).toBe("allow");
  });

  it("still gates shell/delete when requireApproval is explicitly true", async () => {
    const f = fakeSession();
    await applyFiveMPermissions(f.session, { requireApproval: true });
    expect(f.tools[WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]).toBe("ask");
    expect(f.tools[WORKSPACE_TOOLS.FILESYSTEM.DELETE]).toBe("ask");
  });

  it("ALWAYS gates live-server / install / schema ops regardless of the toggle", async () => {
    const f = fakeSession();
    await applyFiveMPermissions(f.session, { requireApproval: false });
    for (const t of [
      "deploy_resource",
      "install_resource",
      "import_schema",
      "start_server",
      "stop_server",
      "restart_server",
    ]) {
      expect(f.tools[t]).toBe("ask");
    }
  });

  it("never gates reads / edits / built-in orchestration tools", async () => {
    const f = fakeSession();
    await applyFiveMPermissions(f.session);
    expect(f.categories.read).toBe("allow");
    expect(f.categories.edit).toBe("allow");
    expect(f.tools.ask_user).toBe("allow");
    expect(f.tools.updateWorkingMemory).toBe("allow");
  });
});
