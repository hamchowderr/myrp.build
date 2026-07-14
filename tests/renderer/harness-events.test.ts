import { describe, expect, it } from "vitest";
import {
  deriveChangedFiles,
  deriveTaskList,
  emptyTranscript,
  type HarnessMessage,
  OPTIMISTIC_USER_ID,
  reduceHarnessEvent,
  reduceHarnessEvents,
  SUPPRESSED_INLINE_TOOLS,
  uiMessagesToHarness,
} from "../../src/renderer/src/lib/harness/events";

/**
 * The pure Harness event reducer (ported from
 * mastra-chat-kit). Exercised against the REAL event shapes observed in the
 * end-to-end spike, so it also acts as a contract check on the Harness output.
 */
describe("reduceHarnessEvent", () => {
  it("folds a full run (thread → user/assistant messages → usage → done)", () => {
    const events = [
      { type: "__thread__", threadId: "thr_1" },
      { type: "agent_start" },
      {
        type: "message_end",
        message: { id: "u1", role: "user", content: [{ type: "text", text: "ping" }] },
      },
      {
        type: "message_end",
        message: {
          id: "a1",
          role: "assistant",
          content: [{ type: "text", text: "pong from ox" }],
          stopReason: "complete",
        },
      },
      { type: "usage_update", usage: { totalTokens: 1097 } },
      { type: "agent_end" },
      { type: "__done__" },
    ];
    const t = reduceHarnessEvents(emptyTranscript(), events);
    expect(t.threadId).toBe("thr_1");
    expect(t.messages).toHaveLength(2);
    expect(t.messages.find((m) => m.role === "assistant")?.content[0]).toMatchObject({
      type: "text",
      text: "pong from ox",
    });
    expect(t.usage?.totalTokens).toBe(1097);
    expect(t.done).toBe(true);
  });

  it("upserts streaming message updates by id (no duplicates)", () => {
    let t = emptyTranscript();
    t = reduceHarnessEvent(t, {
      type: "message_start",
      message: { id: "a1", role: "assistant", content: [] },
    });
    t = reduceHarnessEvent(t, {
      type: "message_update",
      message: { id: "a1", role: "assistant", content: [{ type: "text", text: "po" }] },
    });
    t = reduceHarnessEvent(t, {
      type: "message_end",
      message: { id: "a1", role: "assistant", content: [{ type: "text", text: "pong" }] },
    });
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0].content[0]).toMatchObject({ type: "text", text: "pong" });
  });

  it("sets a pending approval then clears it when the gate resolves", () => {
    let t = emptyTranscript();
    t = reduceHarnessEvent(t, {
      type: "tool_approval_required",
      toolCallId: "tc1",
      toolName: "deploy_resource",
      args: { resource: "demo" },
    });
    expect(t.pendingApproval).toMatchObject({ toolCallId: "tc1", toolName: "deploy_resource" });
    t = reduceHarnessEvent(t, { type: "agent_end" });
    expect(t.pendingApproval).toBeNull();
  });

  it("tracks the active mode (mode_changed)", () => {
    const t = reduceHarnessEvent(emptyTranscript(), {
      type: "mode_changed",
      modeId: "generate",
      previousModeId: "plan",
    });
    expect(t.mode).toBe("generate");
  });

  it("records the logged generation id for feedback thumbs (generation_logged)", () => {
    // The main process forwards this after finalizeGeneration logs the turn; the
    // id powers the feedback thumbs (parity with AEChat).
    expect(emptyTranscript().lastGenerationId).toBeNull();
    const t = reduceHarnessEvent(emptyTranscript(), {
      type: "generation_logged",
      generationId: "gen_42",
    });
    expect(t.lastGenerationId).toBe("gen_42");
  });

  it("stores the ox RAG citations for the turn (rag_sources)", () => {
    // The main process forwards the distinct ox docs that grounded the turn; the
    // UI renders them as a "Used N sources" citation list.
    expect(emptyTranscript().sources).toEqual([]);
    const t = reduceHarnessEvent(emptyTranscript(), {
      type: "rag_sources",
      sources: [
        {
          sourceType: "ox_inventory",
          sourceUrl: "https://overextended.dev/ox_inventory",
          similarity: 0.82,
        },
        {
          sourceType: "ox_target",
          sourceUrl: "https://overextended.dev/ox_target",
          similarity: 0.71,
        },
      ],
    });
    expect(t.sources).toHaveLength(2);
    expect(t.sources[0]).toMatchObject({ sourceType: "ox_inventory" });
  });

  it("tracks active subagents: start adds, tool_start annotates, end removes", () => {
    let t = reduceHarnessEvent(emptyTranscript(), {
      type: "subagent_start",
      toolCallId: "sa1",
      agentType: "lua-specialist",
      task: "write the client script",
      modelId: "anthropic/claude-sonnet-4-6",
    });
    expect(t.activeSubagents).toHaveLength(1);
    expect(t.activeSubagents[0]).toMatchObject({ agentType: "lua-specialist" });

    t = reduceHarnessEvent(t, {
      type: "subagent_tool_start",
      toolCallId: "sa1",
      agentType: "lua-specialist",
      subToolName: "mastra_workspace_write_file",
      subToolArgs: {},
    });
    expect(t.activeSubagents[0].currentTool).toBe("mastra_workspace_write_file");

    t = reduceHarnessEvent(t, {
      type: "subagent_end",
      toolCallId: "sa1",
      agentType: "lua-specialist",
      result: "done",
      isError: false,
      durationMs: 1200,
    });
    expect(t.activeSubagents).toHaveLength(0);
  });

  it("tracks a tool suspension and clears it on the matching tool_end", () => {
    let t = reduceHarnessEvent(emptyTranscript(), {
      type: "tool_suspended",
      toolCallId: "as1",
      toolName: "ask_user",
      args: { question: "Which framework?" },
      suspendPayload: { prompt: "Which framework?" },
    });
    expect(t.pendingSuspensions).toHaveLength(1);
    expect(t.pendingSuspensions[0]).toMatchObject({ toolName: "ask_user" });
    t = reduceHarnessEvent(t, {
      type: "tool_end",
      toolCallId: "as1",
      result: "ox",
      isError: false,
    });
    expect(t.pendingSuspensions).toHaveLength(0);
  });

  it("clears subagents but KEEPS suspensions when the run ends (agent_end)", () => {
    // The real Harness fires tool_suspended → agent_end when a run parks on
    // ask_user (the run ENDS on purpose; the answer drives a separate run). So
    // agent_end must NOT wipe the suspension — that's the card the user answers.
    let t = emptyTranscript();
    t = reduceHarnessEvent(t, {
      type: "subagent_start",
      toolCallId: "sa1",
      agentType: "x",
      task: "t",
      modelId: "m",
    });
    t = reduceHarnessEvent(t, {
      type: "tool_suspended",
      toolCallId: "as1",
      toolName: "ask_user",
      args: {},
      suspendPayload: {},
    });
    t = reduceHarnessEvent(t, { type: "agent_end" });
    expect(t.activeSubagents).toHaveLength(0);
    expect(t.pendingSuspensions).toHaveLength(1);
    // …and it's cleared only when the tool actually resolves (tool_end on resume).
    t = reduceHarnessEvent(t, {
      type: "tool_end",
      toolCallId: "as1",
      result: "ox",
      isError: false,
    });
    expect(t.pendingSuspensions).toHaveLength(0);
  });

  it("keeps the suspension card on __suspended__, clears it on __done__", () => {
    let t = emptyTranscript();
    t = reduceHarnessEvent(t, {
      type: "tool_suspended",
      toolCallId: "as1",
      toolName: "ask_user",
      args: {},
      suspendPayload: { question: "which framework?" },
    });
    // A turn that parks emits __suspended__ (not __done__): the card stays, the
    // conversation is not marked done.
    t = reduceHarnessEvent(t, { type: "__suspended__" });
    expect(t.pendingSuspensions).toHaveLength(1);
    expect(t.done).toBe(false);
    // The resumed turn completes → __done__ clears it and marks done.
    t = reduceHarnessEvent(t, { type: "__done__" });
    expect(t.pendingSuspensions).toHaveLength(0);
    expect(t.done).toBe(true);
  });

  it("swaps the optimistic user placeholder for the Harness's real user echo (71v)", () => {
    // The send path renders an optimistic user message instantly; the Harness then
    // echoes the user turn with its OWN id. The reducer must replace, not duplicate.
    let t = emptyTranscript();
    t = {
      ...t,
      messages: [
        { id: OPTIMISTIC_USER_ID, role: "user", content: [{ type: "text", text: "make a shop" }] },
      ],
    };
    t = reduceHarnessEvent(t, {
      type: "message_start",
      message: { id: "u_real", role: "user", content: [{ type: "text", text: "make a shop" }] },
    });
    const users = t.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0].id).toBe("u_real");
    expect(t.messages.some((m) => m.id === OPTIMISTIC_USER_ID)).toBe(false);
  });

  it("keeps the optimistic placeholder when an assistant message streams first (71v)", () => {
    // Assistant/thinking events must NOT drop the optimistic user bubble — only the
    // real user echo does. Guards the dedupe from over-clearing.
    let t = emptyTranscript();
    t = {
      ...t,
      messages: [{ id: OPTIMISTIC_USER_ID, role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    t = reduceHarnessEvent(t, {
      type: "message_start",
      message: { id: "a1", role: "assistant", content: [] },
    });
    expect(t.messages.some((m) => m.id === OPTIMISTIC_USER_ID)).toBe(true);
    expect(t.messages).toHaveLength(2);
  });

  it("passes truly unknown events through untouched", () => {
    const before = emptyTranscript();
    const after = reduceHarnessEvent(before, { type: "goal_evaluation", payload: {} });
    expect(after).toEqual(before);
  });
});

/**
 * Show-work: the agent's task bookkeeping (task_*) must render
 * as ONE consolidated checklist, not a pile of inline wrench cards, and must
 * survive a reopened conversation (whose transient task_updated events are gone).
 */
describe("task checklist (deriveTaskList + SUPPRESSED_INLINE_TOOLS)", () => {
  it("suppresses builtin bookkeeping tools from inline tool cards, not real tools", () => {
    // task_* + ask_user/submit_plan have dedicated surfaces → hidden as cards.
    for (const t of [
      "task_write",
      "task_update",
      "task_complete",
      "task_check",
      "ask_user",
      "submit_plan",
    ]) {
      expect(SUPPRESSED_INLINE_TOOLS.has(t)).toBe(true);
    }
    // Real work + subagent stay visible.
    for (const t of ["write_file", "validate_resource", "import_schema", "subagent"]) {
      expect(SUPPRESSED_INLINE_TOOLS.has(t)).toBe(false);
    }
  });

  it("prefers the live task_updated snapshot when present", () => {
    const live = [{ id: "1", content: "Write client", status: "in_progress" }];
    const msgs: HarnessMessage[] = [];
    expect(deriveTaskList(msgs, live)).toBe(live);
  });

  it("reconstructs the checklist from the last task-tool result when live is empty", () => {
    // Reopened conversation: no task_updated events, but each task tool RESULT
    // carries the full {tasks} snapshot, which IS persisted with the messages.
    const messages: HarnessMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "tool_result",
            id: "t1",
            name: "task_write",
            result: {
              content: "planned",
              tasks: [
                {
                  id: "1",
                  content: "Write client",
                  status: "pending",
                  activeForm: "Writing client",
                },
                {
                  id: "2",
                  content: "Write server",
                  status: "pending",
                  activeForm: "Writing server",
                },
              ],
            },
          },
          {
            type: "tool_result",
            id: "t2",
            name: "task_complete",
            result: {
              content: "done 1",
              tasks: [
                {
                  id: "1",
                  content: "Write client",
                  status: "completed",
                  activeForm: "Writing client",
                },
                {
                  id: "2",
                  content: "Write server",
                  status: "in_progress",
                  activeForm: "Writing server",
                },
              ],
            },
          },
        ],
      },
    ];
    const derived = deriveTaskList(messages, []);
    // The LAST task-tool result wins (the current snapshot).
    expect(derived).toHaveLength(2);
    expect(derived[0]).toMatchObject({ id: "1", status: "completed" });
    expect(derived[1]).toMatchObject({ id: "2", status: "in_progress" });
  });

  it("returns [] when there are neither live tasks nor task-tool results", () => {
    const messages: HarnessMessage[] = [
      { id: "a1", role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    expect(deriveTaskList(messages, [])).toEqual([]);
  });
});

/**
 * Show-work: file mutations are consolidated into ONE git-style
 * "Changed files" commit card; the inline Wrote/Edited cards + file-read
 * exploration noise are suppressed.
 */
describe("changed-files card (deriveChangedFiles + SUPPRESSED_INLINE_TOOLS)", () => {
  it("suppresses workspace file mutation + read cards from the inline stream", () => {
    for (const t of [
      "mastra_workspace_write_file",
      "mastra_workspace_edit_file",
      "mastra_workspace_ast_edit",
      "mastra_workspace_delete",
      "mastra_workspace_read_file",
      "mastra_workspace_list_files",
      "mastra_workspace_grep",
    ]) {
      expect(SUPPRESSED_INLINE_TOOLS.has(t)).toBe(true);
    }
    // Meaningful app tools + shell exec stay visible.
    for (const t of ["validate_resource", "import_schema", "mastra_workspace_execute_command"]) {
      expect(SUPPRESSED_INLINE_TOOLS.has(t)).toBe(false);
    }
  });

  it("derives git-style changed files from mutation tool calls, deduped by path", () => {
    const messages: HarnessMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "1",
            name: "mastra_workspace_write_file",
            args: { path: "[local]/shop/client.lua" },
          },
          // read is ignored (not a change)
          {
            type: "tool_call",
            id: "2",
            name: "mastra_workspace_read_file",
            args: { path: "[local]/shop/client.lua" },
          },
          // edit of an already-written file → stays "added" (created this turn)
          {
            type: "tool_call",
            id: "3",
            name: "mastra_workspace_edit_file",
            args: { path: "[local]/shop/client.lua" },
          },
          {
            type: "tool_call",
            id: "4",
            name: "mastra_workspace_edit_file",
            args: { path: "[local]/shop/server.lua" },
          },
          {
            type: "tool_call",
            id: "5",
            name: "mastra_workspace_delete",
            args: { path: "[local]/shop/old.lua" },
          },
        ],
      },
    ];
    const files = deriveChangedFiles(messages);
    expect(files).toHaveLength(3);
    expect(files.find((f) => f.path.endsWith("client.lua"))?.status).toBe("added");
    expect(files.find((f) => f.path.endsWith("server.lua"))?.status).toBe("modified");
    expect(files.find((f) => f.path.endsWith("old.lua"))?.status).toBe("deleted");
  });

  it("returns [] when no file mutations occurred", () => {
    const messages: HarnessMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: [{ type: "tool_call", id: "1", name: "validate_resource", args: {} }],
      },
    ];
    expect(deriveChangedFiles(messages)).toEqual([]);
  });
});

/**
 * Loading a past conversation on the Harness path. loadThread
 * returns AI-SDK-v6 UI messages; this converts them to the transcript's
 * HarnessMessage shape so the sidebar can reopen a thread.
 */
describe("uiMessagesToHarness", () => {
  it("converts text, reasoning, and tool call/result parts", () => {
    const ui = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "make a dealership" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "thinking…" },
          { type: "text", text: "Done." },
          {
            type: "tool-write_file",
            toolCallId: "t1",
            input: { path: "client/main.lua" },
            output: { ok: true },
            state: "output-available",
          },
          { type: "dynamic-tool", toolName: "deploy_resource", toolCallId: "t2", input: {} },
        ],
      },
    ];
    const msgs = uiMessagesToHarness(ui);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ id: "u1", role: "user" });
    expect(msgs[0].content).toEqual([{ type: "text", text: "make a dealership" }]);

    const a = msgs[1];
    expect(a.role).toBe("assistant");
    expect(a.content).toContainEqual({ type: "thinking", thinking: "thinking…" });
    expect(a.content).toContainEqual({ type: "text", text: "Done." });
    // tool-<name> → tool_call (name stripped of the "tool-" prefix) + tool_result.
    expect(a.content).toContainEqual({
      type: "tool_call",
      id: "t1",
      name: "write_file",
      args: { path: "client/main.lua" },
    });
    expect(a.content).toContainEqual({
      type: "tool_result",
      id: "t1",
      name: "write_file",
      result: { ok: true },
    });
    // dynamic-tool uses its toolName; no output yet → tool_call only.
    expect(a.content).toContainEqual({
      type: "tool_call",
      id: "t2",
      name: "deploy_resource",
      args: {},
    });
    expect(a.content.filter((p) => p.type === "tool_result")).toHaveLength(1);
  });

  it("skips unknown parts and non-object entries, defaults role to assistant", () => {
    const msgs = uiMessagesToHarness([
      null,
      "nope",
      { id: "x1", role: "tool", parts: [{ type: "step-start" }, { type: "text", text: "hi" }] },
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].content).toEqual([{ type: "text", text: "hi" }]);
  });
});
