import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import { tokenize } from "./syntax-highlighter";

export function ColorizedCode({ content, path }: { content: string; path: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [content]);

  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const canColorize = ["lua", "js", "ts", "sql", "json"].includes(ext);

  const copyBtn = (
    <button
      type="button"
      onClick={handleCopy}
      className="absolute top-1.5 right-1.5 rounded p-0.5 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );

  if (!canColorize) {
    return (
      <div className="relative">
        <pre className="p-3 text-xs whitespace-pre-wrap break-words font-mono text-foreground leading-relaxed">
          {content}
        </pre>
        {copyBtn}
      </div>
    );
  }

  const tokens = tokenize(content, ext);
  return (
    <div className="relative">
      <pre className="p-3 text-xs whitespace-pre-wrap break-words font-mono leading-relaxed">
        {tokens.map((tok, i) => {
          if (tok.type === "keyword")
            return (
              <span key={i} className="text-primary font-semibold">
                {tok.text}
              </span>
            );
          if (tok.type === "string")
            return (
              <span key={i} className="text-chart-2">
                {tok.text}
              </span>
            );
          if (tok.type === "comment")
            return (
              <span key={i} className="text-muted-foreground/60 italic">
                {tok.text}
              </span>
            );
          if (tok.type === "number")
            return (
              <span key={i} className="text-chart-4">
                {tok.text}
              </span>
            );
          return (
            <span key={i} className="text-foreground">
              {tok.text}
            </span>
          );
        })}
      </pre>
      {copyBtn}
    </div>
  );
}
