// Shared helpers for the Studio quality scorers.
//
// They operate on the agent run's OUTPUT trajectory (a MastraDBMessage[]): the
// assistant's text parts + tool-call args, which together contain everything the
// agent generated — including the file contents it wrote via the workspace
// tools. We walk the structure defensively so the scorers stay robust to
// message-shape drift across @mastra/core versions.

type AnyRecord = Record<string, unknown>;

function isRecord(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null;
}

function partsOf(message: unknown): unknown[] {
  if (!isRecord(message) || !isRecord(message.content)) return [];
  const parts = message.content.parts;
  return Array.isArray(parts) ? parts : [];
}

function pick(obj: AnyRecord, keys: string[]): unknown {
  for (const k of keys) if (k in obj) return obj[k];
  return undefined;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

/** All assistant text emitted across the run output. */
export function flattenText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  const chunks: string[] = [];
  for (const message of output) {
    for (const part of partsOf(message)) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n");
}

/** Files the agent wrote, recovered from tool-call args (path + content). */
export function extractWrittenFiles(output: unknown): GeneratedFile[] {
  if (!Array.isArray(output)) return [];
  const files: GeneratedFile[] = [];
  for (const message of output) {
    for (const part of partsOf(message)) {
      if (!isRecord(part) || part.type !== "tool-invocation") continue;
      const inv = part.toolInvocation;
      const args = isRecord(inv) ? inv.args : undefined;
      if (!isRecord(args)) continue;
      const path = pick(args, ["path", "filePath", "file", "filename", "fileName"]);
      const content = pick(args, ["content", "contents", "data", "text", "body"]);
      if (typeof path === "string" && typeof content === "string") {
        files.push({ path, content });
      }
    }
  }
  return files;
}

/** Written-file contents + assistant text — the full body of generated content. */
export function flattenGenerated(output: unknown): string {
  const files = extractWrittenFiles(output).map((f) => `-- ${f.path}\n${f.content}`);
  return [...files, flattenText(output)].join("\n");
}

/** Lua sources: written .lua files, plus fenced ```lua blocks in the text. */
export function extractLua(output: unknown): GeneratedFile[] {
  const lua = extractWrittenFiles(output).filter((f) => f.path.toLowerCase().endsWith(".lua"));
  const text = flattenText(output);
  let i = 0;
  for (const m of text.matchAll(/```lua\s*\n([\s\S]*?)```/g)) {
    lua.push({ path: `block-${++i}.lua`, content: m[1] ?? "" });
  }
  return lua;
}
