import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
 * Verifies the file-tree TAP SOURCE: the Harness emits a
 * `tool_start` for the write_file tool (carrying toolName + args.path) BEFORE it
 * executes, which is what ipc/chat.ts taps to build the GenerationResult. Also
 * confirms the write actually lands on disk. The write-resource fixture drives a
 * single mastra_workspace_write_file call.
 */
describe("runHarnessChat write tap (tool_start → file)", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "harness-write-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("forwards a write_file tool_start with the path, and writes the file", async () => {
    const events: HarnessWireEvent[] = [];
    await runHarnessChat("make manifest", root, {
      resourceId: "ws_t__srv_t",
      indexPaths: [],
      send: (e) => events.push(e),
    });

    const rel = "[local]/test-resource/fxmanifest.lua";
    const writeStart = events.find(
      (e) => e.type === "tool_start" && e.toolName === WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
    );
    expect(writeStart).toBeTruthy();
    expect((writeStart?.args as { path?: string } | undefined)?.path).toBe(rel);
    // The tool actually executed — the file is on disk for the manifest/undo.
    expect(existsSync(join(root, rel))).toBe(true);
  }, 60_000);
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
