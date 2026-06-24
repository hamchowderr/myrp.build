/**
 * Mastra sub-agent layer (epic 55x.24) — ports the Agent-SDK AgentDefinitions in
 * src/main/agents/*.ts to Mastra Agents (which implement SubAgent), registered
 * under the supervisor's `agents` map so it can delegate to them as tools.
 *
 * Deliberately LEAN prompts. The architecture (CLAUDE.md) keeps deep Lua / NUI /
 * security / lore / framework knowledge in the Skills system (Phase 2 / epic
 * 7dr), NOT hardcoded in prompts — so these carry role + responsibility +
 * ox-only constraints, and pull detailed knowledge from skills on demand once
 * that lands. mariadb-expert is intentionally dropped (ox-only -> oxmysql; the
 * supervisor/lua-specialist handle SQL).
 *
 * Workspace assignment: file-touching specialists share the supervisor's
 * workspace (filesystem/sandbox/search tools auto-derived). lore-specialist gets
 * none — it returns naming guidance as text, never writes.
 */
import { Agent } from "@mastra/core/agent";
import type { AnyWorkspace } from "@mastra/core/workspace";

const HAIKU = "anthropic/claude-haiku-4-5";
const SONNET = "anthropic/claude-sonnet-4-5";

/**
 * Build the specialist sub-agents bound to `workspace`. Returns the map the
 * supervisor passes to `agents`. Keys match the names the legacy orchestrator
 * delegated to, so existing routing language stays valid.
 */
export function createSubAgents(workspace: AnyWorkspace): Record<string, Agent> {
  const contextScout = new Agent({
    id: "context-scout",
    name: "Context Scout",
    description:
      "Read-only recon of existing server resources — reads fxmanifest files, scans for ox usage and naming conventions, catalogs existing resource names and exports. Never modifies files.",
    instructions:
      "You scout the server's existing resources to help the generator produce compatible, non-conflicting ox code. Use search and read tools to gather naming conventions, ox_lib/ox_inventory usage, and existing resource names. Report findings concisely. NEVER write or modify files.",
    model: HAIKU,
    workspace,
  });

  const luaSpecialist = new Agent({
    id: "lua-specialist",
    name: "Lua Specialist",
    description:
      "Writes production-ready client/server/shared Lua and fxmanifest.lua for ox_overextended resources. Owns all .lua files.",
    instructions:
      "You write idiomatic ox_overextended Lua (ox_core, ox_lib, ox_inventory, ox_target, oxmysql). Write to the EXACT relative paths the supervisor gives you — do not invent your own layout. Standard layout is the subdirectory form: server/main.lua, client/main.lua, shared/config.lua (NEVER flat files like server.lua at the resource root). Write in dependency order, then fxmanifest.lua LAST declaring EXACTLY the files you wrote at their exact paths (e.g. server_scripts { 'server/main.lua' }) — the manifest paths MUST match the files on disk. Server-authoritative economy, source validation on every net event, ox_lib server callbacks RETURN values (never take a cb parameter), PlayerPedId() not deprecated natives. Depend on ox_lib (+ oxmysql when the DB is used). Load the lua-quality / fw-ox-core / db-oxmysql skills for detailed patterns.",
    model: SONNET,
    workspace,
  });

  const nuiSpecialist = new Agent({
    id: "nui-specialist",
    name: "NUI Specialist",
    description:
      "Builds HTML/CSS/JS NUI overlays (menus, HUDs, shops) with correct SendNUIMessage / RegisterNUICallback / fetch wiring. Owns html/* files.",
    instructions:
      "You build polished, performant in-game NUI (HTML/CSS/JS in html/). Wire SendNUIMessage + RegisterNUICallback, use fetch('https://<resource>/<cb>') from the page, and ALWAYS call SetNuiFocus(false,false) on close. Use the exact event/callback names the plan defines so Lua and NUI stay in sync. Load the nui-patterns / hud-design skills for detail.",
    model: SONNET,
    workspace,
  });

  const loreSpecialist = new Agent({
    id: "lore-specialist",
    name: "Lore Specialist",
    description:
      "Generates GTA V lore-friendly parody names for businesses, brands, vehicles, locations, and items. Returns naming guidance only — writes no files.",
    instructions:
      "You generate lore-friendly parody names that fit Rockstar's satirical GTA V universe (businesses, brands, vehicles, districts, items). Return names + brief rationale as text. You do NOT write files. Load the lore skill for canonical references.",
    model: HAIKU,
  });

  const validator = new Agent({
    id: "validator",
    name: "Validator",
    description:
      "Read-only post-generation validation — checks fxmanifest completeness, source validation, server-authoritative economy, ox correctness, and file references. Never modifies files.",
    instructions:
      "You validate a freshly generated resource. Read its files and report CRITICAL issues (missing/incorrect fxmanifest, files declared-but-missing or present-but-undeclared, client-side economy, missing source validation, deprecated natives, non-ox framework leakage, NUI focus not released) and warnings. Read-only — never edit. Report a concise pass/fail with specifics.",
    model: SONNET,
    workspace,
  });

  const securityAuditor = new Agent({
    id: "security-auditor",
    name: "Security Auditor",
    description:
      "Read-only security review — source validation, server-authoritative economy, injection risks, rate limiting, ACE permission gaps in the FiveM client-server model.",
    instructions:
      "You audit a generated resource for FiveM security flaws: unvalidated net events, client-trusted economy/item logic, SQL built by string concatenation (use oxmysql parameters), missing rate limiting, and ACE permission gaps. Read-only. Report exploitable issues with the file/line and the fix. Load the security skill for patterns.",
    model: HAIKU,
    workspace,
  });

  const docsWriter = new Agent({
    id: "docs-writer",
    name: "Docs Writer",
    description:
      "Reads a generated resource and writes a README.md documenting features, events, exports, config, and setup. Owns README.md.",
    instructions:
      "You read the generated resource and write a clean README.md in the resource root: what it does, dependencies (ox_lib etc.), config keys, events/exports, and install steps. Accurate to the actual files — never invent features.",
    model: HAIKU,
    workspace,
  });

  return {
    "context-scout": contextScout,
    "lua-specialist": luaSpecialist,
    "nui-specialist": nuiSpecialist,
    "lore-specialist": loreSpecialist,
    validator,
    "security-auditor": securityAuditor,
    "docs-writer": docsWriter,
  };
}
