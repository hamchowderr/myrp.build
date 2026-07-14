import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@mastra/core/agent-controller";
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HarnessWireEvent, runHarnessTurn } from "../../src/main/mastra/chat-harness";
import { createFiveMHarness } from "../../src/main/mastra/harness";
import { applyFiveMPermissions } from "../../src/main/mastra/permissions";
import { createFiveMWorkspace } from "../../src/main/mastra/workspace";
import { setupAimock } from "../setup/aimock";

// The approval-delete fixture drives a gated mastra_workspace_delete call.
setupAimock();

const PROMPT = "delete the victim resource";

function localStore(): MastraCompositeStore {
  return new MastraCompositeStore({
    id: "harness-approval-test",
    domains: {
      memory: new InMemoryStore().stores.memory,
      workflows: new InMemoryStore().stores.workflows,
    },
  });
}

/**
 * The Harness HITL path end-to-end through the FiveM permission
 * policy: a gated delete must emit `tool_approval_required` and PARK (the real
 * event verified against @mastra/core's AgentControllerEvent union), then
 * respondToToolApproval must resume (approve → delete runs) or reject (decline →
 * file survives). Filesystem-asserted, like the legacy agent.stream approval test.
 */
describe("Harness HITL approval (AIMock + FiveM policy)", () => {
  let root: string;
  let victim: string;
  let harness: ReturnType<typeof createFiveMHarness>;
  let workspace: ReturnType<typeof createFiveMWorkspace>;

  beforeEach(async () => {
    // Fresh workspace + harness per case so approve/decline don't share state.
    root = mkdtempSync(join(tmpdir(), "harness-approval-"));
    victim = join(root, "[local]", "victim");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "fxmanifest.lua"), "fx_version 'cerulean'\ngame 'gta5'\n");
    // No workspace-level requireApproval — the Harness policy is the sole gate.
    workspace = createFiveMWorkspace(root);
    await workspace.init();
    harness = createFiveMHarness(workspace, { storage: localStore() });
    await harness.init();
  }, 60_000);

  afterEach(async () => {
    await harness.destroy().catch(() => {});
    await workspace.destroy().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  /** Run the gated turn, answering the approval gate mid-flight with `decision`. */
  async function runWithDecision(decision: "approve" | "decline"): Promise<HarnessWireEvent[]> {
    const events: HarnessWireEvent[] = [];
    let session: Session | null = null;
    let responded = false;
    await runHarnessTurn(harness, {
      text: PROMPT,
      resourceId: "ws_t__srv_t",
      onSession: (s) => {
        session = s;
      },
      // requireApproval:true so delete is gated (the policy's optional-gate set).
      prepareSession: (s) => applyFiveMPermissions(s, { requireApproval: true }),
      send: (e) => {
        events.push(e);
        if (e.type === "tool_approval_required" && !responded) {
          responded = true;
          // Defer out of the emit dispatch to avoid re-entrancy into the run loop.
          queueMicrotask(() => session?.respondToToolApproval({ decision }));
        }
      },
    });
    return events;
  }

  it("gates the delete, then approve resumes and deletes", async () => {
    const events = await runWithDecision("approve");
    expect(events.find((e) => e.type === "tool_approval_required")).toMatchObject({
      toolName: "mastra_workspace_delete",
    });
    expect(existsSync(victim)).toBe(false);
  }, 60_000);

  it("decline blocks the delete (file survives)", async () => {
    const events = await runWithDecision("decline");
    expect(events.some((e) => e.type === "tool_approval_required")).toBe(true);
    expect(existsSync(victim)).toBe(true);
  }, 60_000);
});
