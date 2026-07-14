/**
 * myRP.build Harness factory (step 1 — additive).
 *
 * Assembles the Mastra Harness that will REPLACE the createFiveMAgent + manual
 * `new Mastra({ storage })` approval-wrap in the live chat path. This file is
 * intentionally NOT wired into chat.ts yet: the live-path rewire (Harness
 * session + subscription instead of agent.stream()+toAISdkStream, and
 * tool_suspended instead of the manual approval loop) is the coupled landing
 * covering approval, streaming, and UI. Building the factory
 * first lets us verify the real configuration constructs/inits/sessions without
 * touching the running generator.
 *
 * Wiring:
 *  - agent     = the supervisor from createFiveMAgent (its model goes through the
 *                Vercel AI Gateway; its deploy/validate/etc. tools ride
 *                along). useSubAgents is forced OFF — the Harness owns subagents.
 *  - subagents = createSubAgentDefs() — the Harness auto-creates the
 *                `subagent` tool the supervisor calls to delegate; each runs
 *                isolated (forked:false) and tool-scoped (allowedWorkspaceTools).
 *  - storage   = the MastraCompositeStore — Supabase memory + InMemory
 *                workflows; persists threads/messages/state.
 *  - memory    = the per-tenant Mastra Memory (semantic recall + working memory).
 *  - modes     = a single `generate` mode for now (the app's one job); a `plan`
 *                mode (submit_plan HITL) can be added later via transitionsTo.
 */

import type { ToolCategory } from "@mastra/core/agent-controller";
import { Harness } from "@mastra/core/harness";
import type { ObservabilityEntrypoint } from "@mastra/core/observability";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { type AnyWorkspace, WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { createFiveMAgent, type FiveMAgentOptions } from "./agent";
import { createSubAgentDefs } from "./sub-agents";

export const HARNESS_ID = "fivem-generator";

/**
 * Permission categories for the Harness HITL system (consumed by the approval
 * policy). `execute` = mutates the live FXServer or runs a shell command
 * (approval-worthy); `edit` = a sandboxed file mutation; `read` = read-only.
 * Unmapped tools (subagent / ask_user / submit_plan / task_*) fall through to
 * `other`. The categorization lives here; the approval flow owns which categories gate.
 */
const TOOL_CATEGORY: Record<string, ToolCategory> = {
  // App tools that change the running server or run commands → execute.
  deploy_resource: "execute",
  install_resource: "execute",
  import_schema: "execute",
  start_server: "execute",
  stop_server: "execute",
  restart_server: "execute",
  // App read-only checks.
  validate_resource: "read",
  smoke_test_resource: "read",
  server_status: "read",
  // Workspace filesystem reads / search / skills.
  [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: "read",
  [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: "read",
  [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: "read",
  [WORKSPACE_TOOLS.FILESYSTEM.GREP]: "read",
  [WORKSPACE_TOOLS.SEARCH.SEARCH]: "read",
  [WORKSPACE_TOOLS.SEARCH.INDEX]: "read",
  [WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT]: "read",
  skill: "read",
  skill_search: "read",
  skill_read: "read",
  // Workspace file mutations → edit.
  [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: "edit",
  [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: "edit",
  [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: "edit",
  [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT]: "edit",
  [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: "edit",
  // Sandbox command execution → execute.
  [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: "execute",
  [WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS]: "execute",
};

/** Map a tool name to its permission category, or null (→ "other") when unmapped. */
export function fivemToolCategory(toolName: string): ToolCategory | null {
  return TOOL_CATEGORY[toolName] ?? null;
}

export interface FiveMHarnessOptions extends FiveMAgentOptions {
  /** Thread/message/state persistence: the composite store. */
  storage: MastraCompositeStore;
  /** Mastra AI tracing sink. When set, agent + tool runs emit trace spans. */
  observability?: ObservabilityEntrypoint;
}

/**
 * Build the myRP.build Harness bound to `workspace`. Call `await harness.init()`
 * before `createSession`, and pass a workspace (createSession requires one).
 */
export function createFiveMHarness(workspace: AnyWorkspace, opts: FiveMHarnessOptions): Harness {
  const { storage, observability, ...agentOpts } = opts;
  // The Harness owns subagents via `subagents`, so the backing supervisor is
  // built WITHOUT the legacy agents-as-tools map.
  const agent = createFiveMAgent(workspace, { ...agentOpts, useSubAgents: false });
  return new Harness({
    id: HARNESS_ID,
    agent,
    workspace,
    storage,
    ...(opts.memory ? { memory: opts.memory } : {}),
    modes: [{ id: "generate", name: "Generate" }],
    subagents: createSubAgentDefs(),
    // Permission categories for HITL; the policy layer wires the gating policy + suspend/resume.
    toolCategoryResolver: fivemToolCategory,
    // Mastra AI tracing — only when the caller supplies a sink.
    ...(observability ? { observability } : {}),
  });
}
