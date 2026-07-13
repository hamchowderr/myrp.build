import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessWireEvent } from "../../src/main/mastra/chat-harness";
import { createFiveMHarness } from "../../src/main/mastra/harness";
import { applyFiveMPermissions } from "../../src/main/mastra/permissions";
import { createFiveMWorkspace } from "../../src/main/mastra/workspace";
import { emptyTranscript, reduceHarnessEvents } from "../../src/renderer/src/lib/harness/events";
import { setupAimock } from "../setup/aimock";

// The ask-user fixture makes the model call the built-in ask_user tool.
setupAimock();

function localStore(): MastraCompositeStore {
  return new MastraCompositeStore({
    id: "harness-ask-user-test",
    domains: {
      memory: new InMemoryStore().stores.memory,
      workflows: new InMemoryStore().stores.workflows,
    },
  });
}

/**
 * The ask_user HITL path. Two verified facts:
 *
 *  1. POLICY: ask_user must NOT be approval-gated, or the agent's clarifying
 *     question would double-prompt (approve, THEN answer). The BUILTIN_ALLOW set in
 *     applyFiveMPermissions routes it (+ subagent / submit_plan / task_*) straight
 *     to its own suspension. Without it the builtins fall back to 'ask' and emit
 *     tool_approval_required — the wrong UX (and subagent delegation would prompt).
 *  2. RESUME: unlike approval (which parks INSIDE sendMessage), an ask_user
 *     suspension RESOLVES sendMessage and is answered by respondToToolSuspension,
 *     which drives a fresh run that returns the answer to the model. The session +
 *     subscription must outlive the first sendMessage — which is why the live path
 *     drives the session directly (runHarnessTurn's per-call unsubscribe can't
 *     carry a resume; that lifecycle wiring is the remaining IPC follow-up).
 */
describe("Harness ask_user suspension + resume (AIMock + FiveM policy)", () => {
  let root: string;
  let harness: ReturnType<typeof createFiveMHarness>;
  let workspace: ReturnType<typeof createFiveMWorkspace>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "harness-ask-"));
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

  it("suspends on ask_user (not approval), resumes with the answer, completes", async () => {
    const session = await harness.createSession({ resourceId: "ws_t__srv_t" });
    await applyFiveMPermissions(session, { requireApproval: true });
    const events: HarnessWireEvent[] = [];
    const unsubscribe = session.subscribe((e) => events.push(e as HarnessWireEvent));
    await session.thread.create({ title: "Chat" });

    // sendMessage resolves at the suspension (the run pauses for the answer).
    await session.sendMessage({ content: "ask me which framework" });

    // ask_user suspended (NOT approval-gated) and carried the question payload.
    expect(events.some((e) => e.type === "tool_approval_required")).toBe(false);
    const susp = events.find((e) => e.type === "tool_suspended");
    expect(susp).toMatchObject({ toolName: "ask_user" });
    expect((susp?.suspendPayload as { question?: string } | undefined)?.question).toContain(
      "framework",
    );

    // Answer it → respondToToolSuspension drives the resumed run to completion.
    await session.respondToToolSuspension({
      toolCallId: (susp as { toolCallId: string }).toolCallId,
      resumeData: "ox",
    });
    unsubscribe();

    const t = reduceHarnessEvents(emptyTranscript(), events);
    expect(t.pendingSuspensions).toHaveLength(0);
    const text = t.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content)
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toContain("ox_core");
  }, 60_000);
});
