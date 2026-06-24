import { Badge } from "@renderer/components/ui/badge";
import type { ServerContext } from "@renderer/lib/types";
import { Database, Gamepad2, Package, Server } from "lucide-react";

interface ContextBadgesProps {
  context: ServerContext;
}

export function ContextBadges({ context }: ContextBadgesProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge variant="secondary" className="gap-1 font-mono text-[10px] font-normal">
        <Server className="size-2.5" />
        {context.framework}
      </Badge>
      <Badge variant="secondary" className="gap-1 font-mono text-[10px] font-normal">
        <Database className="size-2.5" />
        {context.dbDriver}
      </Badge>
      {context.inventory !== "unknown" && (
        <Badge variant="secondary" className="gap-1 font-mono text-[10px] font-normal">
          <Package className="size-2.5" />
          {context.inventory}
        </Badge>
      )}
      {context.gameBuild && context.gameBuild !== "unknown" && (
        <Badge variant="secondary" className="gap-1 font-mono text-[10px] font-normal">
          <Gamepad2 className="size-2.5" />b{context.gameBuild}
        </Badge>
      )}
    </div>
  );
}
