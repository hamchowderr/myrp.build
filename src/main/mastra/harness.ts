/**
 * myRP.build harness factory.
 *
 * Assembles the Mastra {@link AgentController} (`@mastra/core/agent-controller`
 * — the class formerly exported as `Harness`) that backs the live chat path,
 * replacing the old createFiveMAgent + manual `new Mastra({ storage })`
 * approval-wrap. It IS wired in: `ipc/chat.ts` imports from `chat-harness.ts`,
 * which calls {@link createFiveMHarness} for both the per-turn and the
 * persistent-runtime paths.
 *
 * "Harness" survives in OUR names here (createFiveMHarness, HARNESS_ID) as this
 * app's vocabulary for the orchestration layer; only the Mastra import moved.
 *
 * Wiring:
 *  - agent     = the supervisor from createFiveMAgent (its model goes through the
 *                Vercel AI Gateway; its deploy/validate/etc. tools ride
 *                along). useSubAgents is forced OFF — the controller owns subagents.
 *  - subagents = createSubAgentDefs() — the controller auto-creates the
 *                `subagent` tool the supervisor calls to delegate; each runs
 *                isolated (forked:false) and tool-scoped (allowedWorkspaceTools).
 *  - storage   = the MastraCompositeStore — Supabase memory + InMemory
 *                workflows; persists threads/messages/state.
 *  - memory    = the per-tenant Mastra Memory (semantic recall + working memory).
 *  - modes     = a single `generate` mode (the app's one job), scoped by
 *                `availableTools` so the supervisor CANNOT write files — see
 *                SUPERVISOR_TOOLS. A `plan` mode (submit_plan HITL) can be added
 *                later via transitionsTo.
 */

import { AgentController, type ToolCategory } from "@mastra/core/agent-controller";
import type { ObservabilityEntrypoint } from "@mastra/core/observability";
import type { MastraCompositeStore } from "@mastra/core/storage";
import { type AnyWorkspace, WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { createFiveMAgent, type FiveMAgentOptions } from "./agent";
import { createSubAgentDefs } from "./sub-agents";

export const HARNESS_ID = "fivem-generator";

/**
 * Permission categories for the controller's HITL system (consumed by the approval
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

/**
 * What the SUPERVISOR may call in `generate` mode — a mode-level allowlist
 * (`AgentControllerMode.availableTools`), enforced by Mastra at LLM-call time.
 *
 * WHY THIS EXISTS. `prompt.ts` tells the supervisor "You do NOT write resource
 * files yourself" and to delegate all Lua + the manifest to lua-specialist. It
 * ignored that on the first real generation: it wrote the files itself, spawned
 * no specialist, and so the validator — whose job is catching exactly the ox
 * violation that shipped — never ran. Capturing the request payload showed why:
 * `subagent` WAS offered and the instruction WAS present, but so were
 * write_file, edit_file and mkdir. Given both a rule and the means to bypass it,
 * the model took the direct path.
 *
 * So the four AUTHORING tools are removed from the supervisor's surface —
 * write_file, edit_file, mkdir, ast_edit. Delegation stops being the instructed
 * path and becomes the ONLY path to author a file. The specialists keep their
 * write access; theirs is scoped per-role by `allowedWorkspaceTools` in
 * sub-agents.ts, which this list does not touch.
 *
 * DELETE and EXECUTE_COMMAND deliberately STAY. Neither is authoring, and the
 * specialists hold neither (sub-agents.ts grants only READ_TOOLS + WRITE_TOOLS),
 * so removing them from the supervisor too would leave them reachable by nobody —
 * silently dropping cleanup, the delete approval gate, and any shell-run check.
 *
 * Listing a tool that isn't registered is harmless (nothing matches it), so the
 * conditionally-registered app tools from agent.ts are all named here rather than
 * risking a silent omission when one of them IS present.
 */
const SUPERVISOR_TOOLS: string[] = [
  // Delegation + human-in-the-loop. `subagent` is the whole point of the mode.
  "subagent",
  "ask_user",
  "submit_plan",
  "updateWorkingMemory",
  // The plan the supervisor is supposed to drive to completion.
  "task_write",
  "task_update",
  "task_complete",
  "task_check",
  // Read + search: it must be able to inspect the server it is building into.
  WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES,
  WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT,
  WORKSPACE_TOOLS.FILESYSTEM.GREP,
  WORKSPACE_TOOLS.SEARCH.SEARCH,
  WORKSPACE_TOOLS.SEARCH.INDEX,
  WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT,
  // NOT authoring, and held by no specialist — see the note above.
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
  WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
  WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS,
  // ox knowledge.
  "skill",
  "skill_search",
  "skill_read",
  // The app tools prompt.ts explicitly says the supervisor owns.
  "validate_resource",
  "smoke_test_resource",
  "deploy_resource",
  "install_resource",
  "import_schema",
  "start_server",
  "stop_server",
  "restart_server",
  "server_status",
];

export interface FiveMHarnessOptions extends FiveMAgentOptions {
  /** Thread/message/state persistence: the composite store. */
  storage: MastraCompositeStore;
  /** Mastra AI tracing sink. When set, agent + tool runs emit trace spans. */
  observability?: ObservabilityEntrypoint;
}

/**
 * Build the myRP.build controller bound to `workspace`. Call `await init()`
 * before `createSession`, and pass a workspace (createSession requires one).
 */
export function createFiveMHarness(
  workspace: AnyWorkspace,
  opts: FiveMHarnessOptions,
): AgentController {
  const { storage, observability, ...agentOpts } = opts;
  // The controller owns subagents via `subagents`, so the backing supervisor is
  // built WITHOUT the legacy agents-as-tools map.
  const agent = createFiveMAgent(workspace, { ...agentOpts, useSubAgents: false });
  return new AgentController({
    id: HARNESS_ID,
    agent,
    workspace,
    storage,
    ...(opts.memory ? { memory: opts.memory } : {}),
    // The allowlist is what makes "you coordinate, the specialists write" true
    // rather than merely requested — see SUPERVISOR_TOOLS.
    modes: [{ id: "generate", name: "Generate", availableTools: SUPERVISOR_TOOLS }],
    subagents: createSubAgentDefs(),
    // Permission categories for HITL; the policy layer wires the gating policy + suspend/resume.
    toolCategoryResolver: fivemToolCategory,
    // Mastra AI tracing — only when the caller supplies a sink.
    ...(observability ? { observability } : {}),
  });
}
