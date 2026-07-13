/**
 * Mastra specialist layer (Harness isolation).
 *
 * The 7 specialists are defined ONCE in SPECIALISTS and exposed two ways:
 *  - createSubAgentDefs(): AgentControllerSubagent[] — the Harness-native shape
 *    (passed to `new Harness({ subagents })`). Isolation is expressed
 *    per-specialist via `allowedWorkspaceTools` (each shares the CONTROLLER's
 *    workspace but only sees the tools its role needs) and `forked: false`
 *    (isolated context/memory — a fresh run, not a clone of the supervisor's
 *    thread). The Harness has no per-subagent workspace instance; tool-scoping
 *    IS the workspace isolation.
 *  - createSubAgents(workspace): Record<string, Agent> — the legacy
 *    agents-as-tools shape the current supervisor uses behind the default-OFF
 *    `useSubAgents` flag. DEPRECATED: replaced by createSubAgentDefs
 *    when createFiveMAgent becomes a Harness.
 *
 * Deliberately LEAN prompts. Deep Lua / NUI / security / lore / framework
 * knowledge lives in the Skills system, pulled on demand — so the
 * read-only and text-only specialists keep the skill tools even when their
 * filesystem tools are scoped away. mariadb-expert is intentionally dropped
 * (ox-only -> oxmysql; the supervisor/lua-specialist handle SQL).
 */
import { Agent } from "@mastra/core/agent";
import type { AgentControllerSubagent } from "@mastra/core/agent-controller";
import { type AnyWorkspace, WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { GROUND_RULES } from "./ground-rules";

const HAIKU = "anthropic/claude-haiku-4-5";
const SONNET = "anthropic/claude-sonnet-4-5";

// Skill tools the workspace exposes when skills are configured (knowledge access).
const SKILL_TOOLS = ["skill", "skill_search", "skill_read"];
// Read/recon workspace tools (+ skills) — what a read-only specialist may call.
const READ_TOOLS = [
  WORKSPACE_TOOLS.FILESYSTEM.READ_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES,
  WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT,
  WORKSPACE_TOOLS.FILESYSTEM.GREP,
  WORKSPACE_TOOLS.SEARCH.SEARCH,
  ...SKILL_TOOLS,
];
// File-authoring tools layered on top of READ_TOOLS for writer specialists.
const WRITE_TOOLS = [
  WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
  WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
  WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
];

interface SpecialistSpec {
  id: string;
  name: string;
  description: string;
  instructions: string;
  model: string;
  /** Workspace tools this specialist may call (Harness `allowedWorkspaceTools`). */
  allowedWorkspaceTools: string[];
  /** Legacy builder only: attach the shared workspace? (text-only lore = no.) */
  usesWorkspace: boolean;
}

/**
 * Specialists that WRITE or CHECK ox code get the shared GROUND_RULES appended
 * to their instructions, so they enforce the product invariants directly — not
 * just the supervisor (fixed the bug where lua-specialist ACE-gated a command +
 * told the user to edit server.cfg). Recon/naming/docs specialists don't touch
 * ox code, so they stay lean.
 */
const ENFORCES_GROUND_RULES = new Set([
  "lua-specialist",
  "nui-specialist",
  "validator",
  "security-auditor",
]);

/** A specialist's instructions, with the shared ground rules appended when it writes/checks code. */
function withGroundRules(spec: SpecialistSpec): string {
  return ENFORCES_GROUND_RULES.has(spec.id)
    ? `${spec.instructions}\n\nABSOLUTE RULES — never violate regardless of the task:\n${GROUND_RULES}`
    : spec.instructions;
}

const SPECIALISTS: SpecialistSpec[] = [
  {
    id: "context-scout",
    name: "Context Scout",
    description:
      "Read-only recon of existing server resources — reads fxmanifest files, scans for ox usage and naming conventions, catalogs existing resource names and exports. Never modifies files.",
    instructions:
      "You scout the server's existing resources to help the generator produce compatible, non-conflicting ox code. Use search and read tools to gather naming conventions, ox_lib/ox_inventory usage, and existing resource names. Report findings concisely. NEVER write or modify files.",
    model: HAIKU,
    allowedWorkspaceTools: [...READ_TOOLS],
    usesWorkspace: true,
  },
  {
    id: "lua-specialist",
    name: "Lua Specialist",
    description:
      "Writes production-ready client/server/shared Lua and fxmanifest.lua for ox_overextended resources. Owns all .lua files.",
    instructions:
      "You write idiomatic ox_overextended Lua (ox_core, ox_lib, ox_inventory, ox_target, oxmysql). Write to the EXACT relative paths the supervisor gives you — do not invent your own layout. Standard layout is the subdirectory form: server/main.lua, client/main.lua, shared/config.lua (NEVER flat files like server.lua at the resource root). Write in dependency order, then fxmanifest.lua LAST declaring EXACTLY the files you wrote at their exact paths (e.g. server_scripts { 'server/main.lua' }) — the manifest paths MUST match the files on disk. Server-authoritative economy, source validation on every net event, ox_lib server callbacks RETURN values (never take a cb parameter), PlayerPedId() not deprecated natives. Depend on ox_lib (+ oxmysql when the DB is used). Load the lua-quality / fw-ox-core / db-oxmysql skills for detailed patterns.",
    model: SONNET,
    allowedWorkspaceTools: [...READ_TOOLS, ...WRITE_TOOLS],
    usesWorkspace: true,
  },
  {
    id: "nui-specialist",
    name: "NUI Specialist",
    description:
      "Builds HTML/CSS/JS NUI overlays (menus, HUDs, shops) with correct SendNUIMessage / RegisterNUICallback / fetch wiring. Owns html/* files.",
    instructions:
      "You build polished, performant in-game NUI (HTML/CSS/JS in html/). Wire SendNUIMessage + RegisterNUICallback, use fetch('https://<resource>/<cb>') from the page, and ALWAYS call SetNuiFocus(false,false) on close. Use the exact event/callback names the plan defines so Lua and NUI stay in sync. Load the nui-patterns / hud-design skills for detail.",
    model: SONNET,
    allowedWorkspaceTools: [...READ_TOOLS, ...WRITE_TOOLS],
    usesWorkspace: true,
  },
  {
    id: "lore-specialist",
    name: "Lore Specialist",
    description:
      "Generates GTA V lore-friendly parody names for businesses, brands, vehicles, locations, and items. Returns naming guidance only — writes no files.",
    instructions:
      "You generate lore-friendly parody names that fit Rockstar's satirical GTA V universe (businesses, brands, vehicles, districts, items). Return names + brief rationale as text. You do NOT write files. Load the lore skill for canonical references.",
    model: HAIKU,
    // Text-only: skills for canonical lore, no filesystem/sandbox.
    allowedWorkspaceTools: [...SKILL_TOOLS],
    usesWorkspace: false,
  },
  {
    id: "validator",
    name: "Validator",
    description:
      "Read-only post-generation validation — checks fxmanifest completeness, source validation, server-authoritative economy, ox correctness, and file references. Never modifies files.",
    instructions:
      "You validate a freshly generated resource. Read its files and report CRITICAL issues (missing/incorrect fxmanifest, files declared-but-missing or present-but-undeclared, client-side economy, missing source validation, deprecated natives, non-ox framework leakage, NUI focus not released) and warnings. Read-only — never edit. Report a concise pass/fail with specifics.",
    model: SONNET,
    allowedWorkspaceTools: [...READ_TOOLS],
    usesWorkspace: true,
  },
  {
    id: "security-auditor",
    name: "Security Auditor",
    description:
      "Read-only security review — source validation, server-authoritative economy, injection risks, rate limiting, ACE permission gaps in the FiveM client-server model.",
    instructions:
      "You audit a generated resource for FiveM security flaws: unvalidated net events, client-trusted economy/item logic, SQL built by string concatenation (use oxmysql parameters), missing rate limiting, and ACE permission gaps. Read-only. Report exploitable issues with the file/line and the fix. Load the security skill for patterns.",
    model: HAIKU,
    allowedWorkspaceTools: [...READ_TOOLS],
    usesWorkspace: true,
  },
  {
    id: "docs-writer",
    name: "Docs Writer",
    description:
      "Reads a generated resource and writes a README.md documenting features, events, exports, config, and setup. Owns README.md.",
    instructions:
      "You read the generated resource and write a clean README.md in the resource root: what it does, dependencies (ox_lib etc.), config keys, events/exports, and install steps. Accurate to the actual files — never invent features.",
    model: HAIKU,
    // Reads everything, writes only README (write_file/edit_file — no mkdir/ast/sandbox).
    allowedWorkspaceTools: [
      ...READ_TOOLS,
      WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
      WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
    ],
    usesWorkspace: true,
  },
];

/**
 * Harness-native specialist definitions. The Harness factory passes these to
 * `new Harness({ subagents })`; the Harness auto-creates the `subagent` tool the
 * supervisor calls to delegate. Each runs isolated (`forked: false`) and sees
 * only its role's workspace tools (`allowedWorkspaceTools`).
 */
export function createSubAgentDefs(): AgentControllerSubagent[] {
  return SPECIALISTS.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    instructions: withGroundRules(s),
    defaultModelId: s.model,
    allowedWorkspaceTools: s.allowedWorkspaceTools,
    forked: false,
  }));
}

/**
 * @deprecated Legacy agents-as-tools shape for the supervisor's default-OFF
 * `useSubAgents` path. Replaced by {@link createSubAgentDefs} once
 * createFiveMAgent becomes a Harness. File-touching specialists share `workspace`;
 * lore-specialist gets none (text-only).
 */
export function createSubAgents(workspace: AnyWorkspace): Record<string, Agent> {
  const out: Record<string, Agent> = {};
  for (const s of SPECIALISTS) {
    out[s.id] = new Agent({
      id: s.id,
      name: s.name,
      description: s.description,
      instructions: withGroundRules(s),
      model: s.model,
      ...(s.usesWorkspace ? { workspace } : {}),
    });
  }
  return out;
}
