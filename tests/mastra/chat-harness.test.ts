import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writtenPathFromEvent } from "../../src/main/ipc/generation-finalize";
import {
  type HarnessWireEvent,
  runHarnessChat,
  runHarnessTurn,
} from "../../src/main/mastra/chat-harness";
import { createFiveMHarness } from "../../src/main/mastra/harness";
import { createFiveMWorkspace } from "../../src/main/mastra/workspace";
import { emptyTranscript, reduceHarnessEvents } from "../../src/renderer/src/lib/harness/events";
import { setupAimock } from "../setup/aimock";

// OPENAI_BASE_URL so the supervisor's gateway model resolves to AIMock.
setupAimock();

/**
 * Exercises BOTH halves of the Harness chat port together:
 * the main-side orchestration (runHarnessTurn) forwards events, and the renderer
 * reducer (reduceHarnessEvents) folds them into the transcript the AI Elements
 * render. No IPC/Electron — `send` collects events in-process.
 */
describe("runHarnessTurn → reduceHarnessEvents", () => {
  let root: string;
  let harness: ReturnType<typeof createFiveMHarness>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "chat-harness-"));
    const workspace = createFiveMWorkspace(root, { interactive: false });
    await workspace.init();
    const storage = new MastraCompositeStore({
      id: "chat-harness-test",
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

  it("forwards a thread id, the assistant reply, and a done sentinel", async () => {
    const events: HarnessWireEvent[] = [];
    const threadId = await runHarnessTurn(harness, {
      text: "ping",
      resourceId: "ws_t__srv_t",
      send: (e) => events.push(e),
    });

    // Sentinels are present and frame the run (subscribe emits an initial state
    // event first, so __thread__ isn't index 0 — assert membership).
    expect(events.find((e) => e.type === "__thread__")).toMatchObject({ threadId });
    expect(events.at(-1)).toMatchObject({ type: "__done__" });

    // Folding the forwarded events reproduces the transcript the UI renders.
    const transcript = reduceHarnessEvents(emptyTranscript(), events);
    expect(transcript.threadId).toBe(threadId);
    expect(transcript.done).toBe(true);
    const assistant = transcript.messages.find((m) => m.role === "assistant");
    const text = (assistant?.content ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toContain("pong from ox");
  }, 60_000);
});

/**
 * The file-tree TAP SOURCE that ipc/chat.ts uses to build the GenerationResult.
 *
 * This used to drive AIMock and assert the supervisor's own write landed on disk.
 * That is no longer possible on purpose: the supervisor's authoring tools were
 * removed (SUPERVISOR_TOOLS in mastra/harness.ts) so it must delegate, and
 * `availableTools` blocks execution as well as visibility — the fixture's direct
 * write_file call is now refused. Specialists author the files instead, and their
 * calls arrive as `subagent_tool_start` with args under `subToolArgs`.
 *
 * So the tap is tested directly rather than through a round trip. A miss here is
 * silent and expensive: the file exists on disk but never reaches the manifest,
 * so it cannot be undone and never shows in the ArtifactPanel.
 */
describe("generation write tap", () => {
  const WRITE = WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE;
  const rel = "[local]/test-resource/fxmanifest.lua";

  it("tracks a supervisor write (tool_start / args)", () => {
    expect(
      writtenPathFromEvent({ type: "tool_start", toolName: WRITE, args: { path: rel } }, WRITE),
    ).toBe(rel);
  });

  it("tracks a SPECIALIST write (subagent_tool_start / subToolArgs)", () => {
    // The path that now carries every generated file. Tapping only tool_start
    // would drop all of them.
    expect(
      writtenPathFromEvent(
        { type: "subagent_tool_start", subToolName: WRITE, subToolArgs: { path: rel } },
        WRITE,
      ),
    ).toBe(rel);
  });

  it("ignores other tools and malformed args", () => {
    expect(
      writtenPathFromEvent(
        { type: "tool_start", toolName: "validate_resource", args: { path: rel } },
        WRITE,
      ),
    ).toBeUndefined();
    expect(writtenPathFromEvent({ type: "tool_start", toolName: WRITE }, WRITE)).toBeUndefined();
    expect(
      writtenPathFromEvent({ type: "tool_start", toolName: WRITE, args: { path: 42 } }, WRITE),
    ).toBeUndefined();
    expect(writtenPathFromEvent({ type: "tool_end" }, WRITE)).toBeUndefined();
  });
});

/**
 * Exercises the per-turn LIFECYCLE wrapper runHarnessChat: it
 * builds + inits the workspace AND the Harness from scratch, drives the turn, and
 * tears both down. This is what ipc/chat.ts calls (behind the useHarness flag),
 * replacing createFiveMAgent + the manual `new Mastra({storage})` wrap. No
 * storage is passed, so it exercises the local in-memory fallback path.
 */
describe("runHarnessChat (full per-turn lifecycle)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "harness-chat-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("builds the Harness, runs a turn, and tears down — reply flows end-to-end", async () => {
    const events: HarnessWireEvent[] = [];
    let captured: unknown;
    const threadId = await runHarnessChat("ping", root, {
      resourceId: "ws_t__srv_t",
      indexPaths: [],
      send: (e) => events.push(e),
      onSession: (s) => {
        captured = s;
      },
    });

    // The session was handed to the caller (so the IPC layer can approve/cancel).
    expect(captured).toBeTruthy();
    expect(events.at(-1)).toMatchObject({ type: "__done__" });

    const transcript = reduceHarnessEvents(emptyTranscript(), events);
    expect(transcript.threadId).toBe(threadId);
    expect(transcript.done).toBe(true);
    const assistant = transcript.messages.find((m) => m.role === "assistant");
    const text = (assistant?.content ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toContain("pong from ox");
  }, 60_000);
});
