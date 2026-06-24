import { useEffect, useState } from "react";
import { buildInlinedHtml } from "./nui-preview-builder";

export function NuiPreview({ absolutePath, content }: { absolutePath: string; content: string }) {
  const [inlinedHtml, setInlinedHtml] = useState<string | null>(null);
  const [building, setBuilding] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setBuilding(true);
    buildInlinedHtml(content, absolutePath).then((html) => {
      if (!cancelled) {
        setInlinedHtml(html);
        setBuilding(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [content, absolutePath]);

  if (building) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground font-mono">
        Building preview...
      </div>
    );
  }

  return (
    <iframe
      srcDoc={inlinedHtml ?? ""}
      className="w-full h-full border-0 rounded-sm"
      sandbox="allow-scripts"
      title="NUI Preview"
    />
  );
}
