/**
 * FiveM HITL permission policy for the Harness.
 *
 * The Harness resolves a tool's effective approval policy from per-tool rules,
 * then category rules, falling back to 'ask' when nothing matches — so WITHOUT an
 * explicit policy every tool (even reads) would prompt. {@link applyFiveMPermissions}
 * sets the baselines: reads / file writes / orchestration tools run freely, the
 * live-server + install + schema ops always pause, and plain shell exec + delete
 * pause BY DEFAULT (secure default — a prompt injection reaching execute_command
 * would otherwise be host code execution), unless the user EXPLICITLY turned the
 * Settings approval toggle off (file writes always land; execute_command + delete
 * gate unless opted out; deploy/install/import_schema/server-lifecycle always gate).
 *
 * Categories come from {@link fivemToolCategory}; this owns which of them gate.
 */
import type { Session } from "@mastra/core/agent-controller";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";

/** Live-server / install / schema ops — ALWAYS pause, independent of the toggle. */
const ALWAYS_GATE = [
  "deploy_resource",
  "install_resource",
  "import_schema",
  "start_server",
  "stop_server",
  "restart_server",
] as const;

/** Shell execution + workspace delete — pause ONLY when the user enabled approval. */
const OPTIONAL_GATE = [
  WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND,
  WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS,
  WORKSPACE_TOOLS.FILESYSTEM.DELETE,
] as const;

/**
 * Built-in Harness orchestration + memory tools that must NEVER hit the approval
 * gate. The toolCategoryResolver returns null for these (no FiveM category), and the
 * Harness falls back to 'ask' for null-category tools — which would wrongly prompt
 * for approval on every subagent delegation, task update, clarifying question,
 * plan submission, or working-memory write. ask_user / submit_plan still pause for
 * input, but via their OWN suspension (answered with respondToToolSuspension), not
 * the approval gate. updateWorkingMemory is internal bookkeeping the agent does to
 * persist context — it is never a user-facing action, so it must run silently.
 */
const BUILTIN_ALLOW = [
  "ask_user",
  "submit_plan",
  "subagent",
  "task_write",
  "task_update",
  "task_complete",
  "task_check",
  "updateWorkingMemory",
] as const;

/**
 * Apply the FiveM HITL policy to a Harness session. Idempotent (persists to
 * session/thread state) — safe to call on every turn. Per-tool rules win over
 * category rules, so the OPTIONAL_GATE 'allow' overrides the 'execute' category's
 * 'ask' when approval is off.
 */
export async function applyFiveMPermissions(
  session: Session,
  opts: { requireApproval?: boolean } = {},
): Promise<void> {
  // Baselines: never gate reads, file writes/edits, mcp, or the built-in
  // orchestration tools (subagent / ask_user / submit_plan / task_*). ask_user
  // runs its own HITL via suspension, not the approval gate.
  await session.permissions.setForCategory({ category: "read", policy: "allow" });
  await session.permissions.setForCategory({ category: "edit", policy: "allow" });
  await session.permissions.setForCategory({ category: "mcp", policy: "allow" });
  await session.permissions.setForCategory({ category: "other", policy: "allow" });
  // Live-server / install / schema ops gate by category…
  await session.permissions.setForCategory({ category: "execute", policy: "ask" });

  // …plain shell exec + delete + kill (also 'execute'/'edit') gate BY DEFAULT
  // (secure default: prompt-injection → host exec is the risk), unless the user
  // EXPLICITLY turned the Settings approval toggle off. A per-tool rule overrides
  // the category baseline.
  const optional = opts.requireApproval === false ? "allow" : "ask";
  for (const toolName of OPTIONAL_GATE) {
    await session.permissions.setForTool({ toolName, policy: optional });
  }
  // Pin the always-gate ops per-tool too, so a future category remap can't
  // silently un-gate a live-server mutation.
  for (const toolName of ALWAYS_GATE) {
    await session.permissions.setForTool({ toolName, policy: "ask" });
  }
  // The built-in orchestration tools have no FiveM category → would default to
  // 'ask'. Explicitly allow them so delegation / tasks / ask_user / submit_plan
  // run freely (the latter two still pause via their own suspension).
  for (const toolName of BUILTIN_ALLOW) {
    await session.permissions.setForTool({ toolName, policy: "allow" });
  }
}
