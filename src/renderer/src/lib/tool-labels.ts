/**
 * Friendly labels for AI-Elements Tool headers (fivem-studio-k8v). Maps the raw
 * Mastra workspace/skill tool names (the UIMessage tool part `type`, which is
 * `tool-<name>`) to short human verbs, and appends the relevant target (file
 * path / skill name / query) pulled from the tool input.
 *
 * Renderer-side mirror of main's stream-map TOOL_NAME_MAP (can't import main
 * code into the renderer). Names are the `mastra_workspace_*` ids + skill tools.
 */
const VERBS: Record<string, string> = {
  mastra_workspace_read_file: "Read",
  mastra_workspace_write_file: "Wrote",
  mastra_workspace_edit_file: "Edited",
  mastra_workspace_ast_edit: "Edited",
  mastra_workspace_list_files: "Listed files",
  mastra_workspace_delete: "Deleted",
  mastra_workspace_file_stat: "Inspected",
  mastra_workspace_mkdir: "Created folder",
  mastra_workspace_grep: "Searched",
  mastra_workspace_execute_command: "Ran command",
  mastra_workspace_search: "Searched workspace",
  mastra_workspace_index: "Indexed",
  mastra_workspace_lsp_inspect: "Inspected",
  skill: "Loaded skill",
  skill_search: "Searched skills",
  skill_read: "Read skill",
};

function field(input: unknown, keys: string[]): string | undefined {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of keys) {
      if (typeof o[k] === "string" && o[k]) return o[k] as string;
    }
  }
  return undefined;
}

/** Build a short, human-readable label for a tool part. */
export function toolLabel(type: string, input: unknown): string {
  const raw = type === "dynamic-tool" ? "" : type.replace(/^tool-/, "");
  const verb = VERBS[raw] ?? raw.replace(/^mastra_workspace_/, "");

  // Skill tools carry a skill name; filesystem tools carry a path; search a query.
  const skill = field(input, ["name", "skill", "skillName"]);
  const path = field(input, ["path", "filePath", "file", "targetPath"]);
  const query = field(input, ["query", "pattern", "command"]);

  if (raw.startsWith("skill") && skill) return `${verb}: ${skill}`;
  if (path) return `${verb} ${path}`;
  if (query) return `${verb}: ${query}`;
  return verb;
}
