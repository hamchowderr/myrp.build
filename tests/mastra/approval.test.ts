import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toAISdkStream } from "@mastra/ai-sdk";
import type { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import type { MastraModelOutput } from "@mastra/core/stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFiveMAgent } from "../../src/main/mastra/agent";
import { createFiveMWorkspace } from "../../src/main/mastra/workspace";
import { setupAimock } from "../setup/aimock";

// Deterministic mock LLM; the approval-delete fixture drives a gated delete call.
setupAimock();

const AGENT_KEY = "fivem-generator";
const PROMPT = "delete the victim resource";

/**
 * Build the approval-capable agent exactly as chat.ts does — a Mastra INSTANCE
 * with storage so approveToolCall/declineToolCall can snapshot/resume — but with
 * an in-memory store (no Postgres, CI-safe) and the workspace's sensitive ops
 * gated behind approval.
 */
function buildApprovalAgent(resourcesRoot: string): {
  agent: Agent;
  destroy: () => Promise<void>;
} {
  const workspace = createFiveMWorkspace(resourcesRoot, {
    requireApproval: true,
  });
  const baseAgent = createFiveMAgent(workspace, { resourcesRoot });
  const agent = new Mastra({
    storage: new InMemoryStore(),
    agents: { [AGENT_KEY]: baseAgent },
  }).getAgent(AGENT_KEY);
  return {
    agent,
    destroy: async () => {
      await workspace.destroy().catch(() => {});
    },
  };
}

/** Consume a stream; report if it paused for approval (runId) and if delete ran. */
async function pump(output: MastraModelOutput): Promise<{
  pausedRunId?: string;
  sawToolResult: boolean;
}> {
  let pausedRunId: string | undefined;
  let sawToolResult = false;
  const ui = toAISdkStream(output, {
    from: "agent",
    version: "v6",
    sendReasoning: true,
  });
  const reader = ui.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const type = (value as { type?: string }).type;
    if (type === "tool-approval-request") pausedRunId = output.runId;
    if (type === "tool-output-available" || type === "tool-result") sawToolResult = true;
  }
  return { pausedRunId, sawToolResult };
}

describe("sensitive-op approval flow (AIMock + in-memory storage)", () => {
  let root: string;
  let victim: string;

  beforeEach(() => {
    // Fresh workspace each case so approve/decline don't see each other's state.
    root = mkdtempSync(join(tmpdir(), "fivem-approval-"));
    victim = join(root, "[local]", "victim");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "fxmanifest.lua"), "fx_version 'cerulean'\ngame 'gta5'\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("pauses for approval, then approveToolCall resumes and deletes", async () => {
    const { agent, destroy } = buildApprovalAgent(root);
    try {
      let output = await agent.stream(PROMPT);
      const { pausedRunId } = await pump(output);

      // The gated delete must pause for approval — not run immediately.
      expect(pausedRunId).toBeTruthy();
      expect(existsSync(victim)).toBe(true);

      // Approve → resume the same run → the delete now executes.
      output = await agent.approveToolCall({ runId: pausedRunId as string });
      await pump(output);
      expect(existsSync(victim)).toBe(false);
    } finally {
      await destroy();
    }
  });

  it("declineToolCall blocks the delete (file survives)", async () => {
    const { agent, destroy } = buildApprovalAgent(root);
    try {
      let output = await agent.stream(PROMPT);
      const { pausedRunId } = await pump(output);
      expect(pausedRunId).toBeTruthy();

      // Decline → the gated delete must NOT run.
      output = await agent.declineToolCall({ runId: pausedRunId as string });
      await pump(output);
      expect(existsSync(victim)).toBe(true);
    } finally {
      await destroy();
    }
  });
});
