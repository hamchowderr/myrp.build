import { describe, expect, it } from "vitest";
import { createSubAgentDefs } from "../../src/main/mastra/sub-agents";

/**
 * The Harness-native specialist definitions. Verifies the
 * isolation knobs (allowedWorkspaceTools + forked) are scoped per role, so when
 * the live path passes these to `new Harness({ subagents })` each specialist sees only the
 * workspace tools its job needs. No LLM, no workspace — pure shape assertions.
 */
const WRITE_FILE = "mastra_workspace_write_file";
const EDIT_FILE = "mastra_workspace_edit_file";
const DELETE = "mastra_workspace_delete";
const EXEC = "mastra_workspace_execute_command";
const READ_FILE = "mastra_workspace_read_file";

describe("Harness subagent definitions", () => {
  const defs = createSubAgentDefs();
  const byId = Object.fromEntries(defs.map((d) => [d.id, d]));
  const toolsOf = (id: string) => byId[id]?.allowedWorkspaceTools ?? [];

  it("defines all 7 specialists", () => {
    expect(defs.map((d) => d.id).sort()).toEqual(
      [
        "context-scout",
        "docs-writer",
        "lore-specialist",
        "lua-specialist",
        "nui-specialist",
        "security-auditor",
        "validator",
      ].sort(),
    );
  });

  it("every def is isolated (forked:false) with a model + scoped tools", () => {
    for (const d of defs) {
      expect(d.forked).toBe(false);
      expect(d.defaultModelId).toBeTruthy();
      expect(d.allowedWorkspaceTools?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("read-only specialists cannot write, delete, or run commands", () => {
    for (const id of ["context-scout", "validator", "security-auditor"]) {
      const tools = toolsOf(id);
      expect(tools).not.toContain(WRITE_FILE);
      expect(tools).not.toContain(EDIT_FILE);
      expect(tools).not.toContain(DELETE);
      expect(tools).not.toContain(EXEC);
      // ...but they can still read files and load skills for knowledge.
      expect(tools).toContain(READ_FILE);
      expect(tools).toContain("skill_search");
    }
  });

  it("writer specialists can author files", () => {
    for (const id of ["lua-specialist", "nui-specialist", "docs-writer"]) {
      expect(toolsOf(id)).toContain(WRITE_FILE);
    }
  });

  it("no specialist gets a sandbox command tool (none run shell)", () => {
    for (const d of defs) expect(d.allowedWorkspaceTools).not.toContain(EXEC);
  });

  it("lore-specialist is text-only: skills, no filesystem", () => {
    const tools = toolsOf("lore-specialist");
    expect(tools).toContain("skill_read");
    expect(tools).not.toContain(READ_FILE);
    expect(tools).not.toContain(WRITE_FILE);
  });
});
