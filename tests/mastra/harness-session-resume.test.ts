import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHarnessRuntime,
  disposeHarnessRuntime,
  type HarnessRuntime,
  type HarnessWireEvent,
  resumeHarnessSuspension,
  sendHarnessTurn,
} from "../../src/main/mastra/chat-harness";
import { emptyTranscript, reduceHarnessEvents } from "../../src/renderer/src/lib/harness/events";
import { setupAimock } from "../setup/aimock";

// The ask-user fixture makes the model call the built-in ask_user tool.
setupAimock();

function localStore(): MastraCompositeStore {
  return new MastraCompositeStore({
    id: "harness-session-resume-test",
    domains: {
      memory: new InMemoryStore().stores.memory,
      workflows: new InMemoryStore().stores.workflows,
    },
  });
}

/**
 * The PERSISTENT session lifecycle. The live path can't rebuild
 * the Harness per turn: an ask_user suspension resolves sendMessage and is answered
 * by a SEPARATE respondToToolSuspension that drives a fresh run, so the session +
 * subscription must outlive the turn. buildHarnessRuntime keeps one session alive;
 * sendHarnessTurn / resumeHarnessSuspension drive turns on it and emit the
 * __suspended__ (keep the card) vs __done__ (run finished) transport sentinels.
 */
describe("Harness persistent runtime: suspend on one turn, resume on the next", () => {
  let root: string;
  let runtime: HarnessRuntime;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "harness-runtime-"));
    runtime = await buildHarnessRuntime(root, {
      key: "test",
      resourceId: "ws_t__srv_t",
      storage: localStore(),
      requireApproval: true,
    });
  }, 60_000);

  afterEach(async () => {
    await disposeHarnessRuntime(runtime);
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the session alive across a suspend → resume, with the right sentinels", async () => {
    const events: HarnessWireEvent[] = [];
    const send = (e: HarnessWireEvent): void => {
      events.push(e);
    };

    // Turn 1: the model asks a clarifying question → the run parks on ask_user.
    const turn = await sendHarnessTurn(runtime, { text: "ask me which framework", send });
    expect(turn.suspended).toBe(true);

    // ask_user suspended (NOT approval-gated) and the turn ended with __suspended__,
    // never __done__ — so the reducer keeps the suspension card the user answers.
    expect(events.some((e) => e.type === "tool_approval_required")).toBe(false);
    const susp = events.find((e) => e.type === "tool_suspended");
    expect(susp).toMatchObject({ toolName: "ask_user" });
    expect(events.at(-1)).toEqual({ type: "__suspended__" });
    expect(events.some((e) => e.type === "__done__")).toBe(false);

    // The card MUST survive between suspend and resume (agent_end fires in between)
    // — it's what the user answers.
    const afterTurn = reduceHarnessEvents(emptyTranscript(), events);
    expect(afterTurn.pendingSuspensions).toHaveLength(1);
    expect(afterTurn.done).toBe(false);

    // Turn 2: answer the suspension on the SAME session → the resumed run completes.
    const resume = await resumeHarnessSuspension(runtime, {
      toolCallId: (susp as { toolCallId: string }).toolCallId,
      resumeData: "ox",
      send,
    });
    expect(resume.suspended).toBe(false);
    expect(events.at(-1)).toEqual({ type: "__done__" });

    const final = reduceHarnessEvents(emptyTranscript(), events);
    expect(final.pendingSuspensions).toHaveLength(0);
    const text = final.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content)
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toContain("ox_core");
  }, 60_000);
});
