export type Token = {
  type: "keyword" | "string" | "comment" | "number" | "plain";
  text: string;
};

export function tokenize(code: string, ext: string): Token[] {
  const isLua = ext === "lua";
  const isJS = ["js", "ts", "json"].includes(ext);
  const isSql = ext === "sql";

  const luaKeywords =
    /\b(local|function|end|if|then|else|elseif|for|while|do|return|and|or|not|nil|true|false|require|exports|AddEventHandler|RegisterNetEvent|TriggerEvent|TriggerClientEvent|TriggerServerEvent|RegisterCommand|Citizen)\b/g;
  const jsKeywords =
    /\b(const|let|var|function|return|if|else|for|while|import|export|default|class|new|async|await|true|false|null|undefined|typeof|instanceof)\b/g;
  const sqlKeywords =
    /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|TABLE|FROM|WHERE|AND|OR|NOT|NULL|PRIMARY|KEY|AUTO_INCREMENT|INT|VARCHAR|TEXT|BOOLEAN|DEFAULT|IF|EXISTS|DROP|ALTER|INDEX|UNIQUE)\b/gi;

  const tokens: Token[] = [];
  const lines = code.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i > 0) tokens.push({ type: "plain", text: "\n" });

    // single-line comment
    const commentPrefix = isLua ? "--" : isJS ? "//" : isSql ? "--" : null;
    if (commentPrefix && line.trimStart().startsWith(commentPrefix)) {
      tokens.push({ type: "comment", text: line });
      continue;
    }

    // run regex tokenization on the line
    const kw = isLua ? luaKeywords : isJS ? jsKeywords : isSql ? sqlKeywords : null;
    const combined = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+\.?\d*\b)/g;

    let pos = 0;
    const matches: Array<{
      start: number;
      end: number;
      text: string;
      type: Token["type"];
    }> = [];

    if (kw) {
      kw.lastIndex = 0;
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec iteration idiom
      while ((m = kw.exec(line)) !== null) {
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          text: m[0],
          type: "keyword",
        });
      }
    }
    combined.lastIndex = 0;
    let m2: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec iteration idiom
    while ((m2 = combined.exec(line)) !== null) {
      const t: Token["type"] =
        m2[0].startsWith('"') || m2[0].startsWith("'") || m2[0].startsWith("`")
          ? "string"
          : "number";
      matches.push({
        start: m2.index,
        end: m2.index + m2[0].length,
        text: m2[0],
        type: t,
      });
    }

    // sort by start, resolve overlaps (keyword wins over number/string if overlapping)
    matches.sort((a, b) => a.start - b.start || (a.type === "keyword" ? -1 : 1));
    const used: typeof matches = [];
    for (const match of matches) {
      if (used.length === 0 || match.start >= used[used.length - 1].end) {
        used.push(match);
      }
    }

    for (const match of used) {
      if (match.start > pos) tokens.push({ type: "plain", text: line.slice(pos, match.start) });
      tokens.push({ type: match.type, text: match.text });
      pos = match.end;
    }
    if (pos < line.length) tokens.push({ type: "plain", text: line.slice(pos) });
  }
  return tokens;
}
