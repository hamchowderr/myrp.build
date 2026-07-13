import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFiveMHarness } from "../../src/main/mastra/harness";
import { createFiveMWorkspace } from "../../src/main/mastra/workspace";
import { setupAimock } from "../setup/aimock";

// OPENAI_BASE_URL so the supervisor's gateway model resolves to AIMock.
setupAimock();

/**
 * Runs the Harness end-to-end (session.subscribe +
 * sendMessage) via AIMock and asserts the output event model. The assistant
 * reply arrives as UIMessage-shaped content-parts on `message_end`, which is
 * what makes the minimal event->UIMessage bridge feasible for the live-path
 * rewire (the chat transcript renderer can stay; DisplayState drives the new
 * mode/subagent/token/approval surfaces additively).
 */
describe("createFiveMHarness end-to-end run", () => {
  let root: string;
  let harness: ReturnType<typeof createFiveMHarness>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "harness-run-"));
    const workspace = createFiveMWorkspace(root, { interactive: false });
    await workspace.init();
    const storage = new MastraCompositeStore({
      id: "harness-run",
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

  it("emits agent/message/usage events and the assistant reply as content-parts", async () => {
    const session = await harness.createSession({ resourceId: "ws_t__srv_t" });
    const events: Array<{ type: string; message?: { role?: string; content?: unknown } }> = [];
    const unsub = session.subscribe((e) => events.push(e as (typeof events)[number]));
    await session.sendMessage({ content: "ping" });
    unsub();

    const types = new Set(events.map((e) => e.type));
    expect(types).toContain("agent_start");
    expect(types).toContain("agent_end");
    expect(types).toContain("message_end");
    expect(types).toContain("display_state_changed"); // the DisplayState-driven surface
    expect(types).toContain("usage_update"); // token-usage stream

    // The assistant reply is UIMessage-shaped content-parts ([{type:'text',text}]).
    const assistant = events
      .filter((e) => e.type === "message_end")
      .map((e) => e.message)
      .find((m) => m?.role === "assistant");
    expect(assistant).toBeTruthy();
    const parts = (assistant?.content ?? []) as Array<{ type: string; text?: string }>;
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
    expect(text).toContain("pong from ox");
  }, 60_000);
});
