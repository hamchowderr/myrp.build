import type { ExtractedCoordinate } from "@renderer/lib/coordinate-parser";
import { useCallback, useState } from "react";

type ExportFormat = "lua" | "json";

interface ExportCoordsProps {
  coordinates: ExtractedCoordinate[];
}

export function ExportCoords({ coordinates }: ExportCoordsProps) {
  const [copied, setCopied] = useState(false);

  const exportAs = useCallback(
    (format: ExportFormat) => {
      if (coordinates.length === 0) return;

      let text: string;
      if (format === "lua") {
        const lines = coordinates.map(
          (c) =>
            `    vector3(${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}), -- ${c.type}: ${c.source.file}:${c.source.line}`,
        );
        text = `local coords = {\n${lines.join("\n")}\n}`;
      } else {
        const data = coordinates.map((c) => ({
          x: Number(c.x.toFixed(2)),
          y: Number(c.y.toFixed(2)),
          z: Number(c.z.toFixed(2)),
          type: c.type,
          source: `${c.source.file}:${c.source.line}`,
        }));
        text = JSON.stringify(data, null, 2);
      }

      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    },
    [coordinates],
  );

  if (coordinates.length === 0) return null;

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => exportAs("lua")}
        className={`rounded px-1.5 py-0.5 font-mono text-[9px] transition-colors ${
          copied
            ? "bg-accent-green/20 text-accent-green"
            : "text-text-dim hover:bg-hover hover:text-text-primary"
        }`}
      >
        {copied ? "Copied!" : "Export Lua"}
      </button>
      <button
        type="button"
        onClick={() => exportAs("json")}
        className="rounded px-1.5 py-0.5 font-mono text-[9px] text-text-dim hover:bg-hover hover:text-text-primary transition-colors"
      >
        Export JSON
      </button>
    </div>
  );
}
