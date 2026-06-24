/**
 * Checkpoint — AI Elements component (https://elements.ai-sdk.dev/components/checkpoint).
 * A restore-point marker for the conversation (icon + trigger + separator lines),
 * inspired by VSCode Copilot checkpoints. UI-only — the parent owns what "restore"
 * does (here: undo the generation's written files). Authored to match the registry
 * anatomy with our Button/cn instead of the CLI (which wanted to overwrite ours).
 */
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { BookmarkIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export type CheckpointProps = ComponentProps<"div">;

/** Centered marker flanked by separator lines, dividing conversation segments. */
export function Checkpoint({ className, children, ...props }: CheckpointProps) {
  return (
    <div
      className={cn("flex items-center gap-2 py-2 text-[11px] text-muted-foreground", className)}
      {...props}
    >
      <div className="h-px flex-1 bg-border-subtle" />
      <div className="flex items-center gap-1.5">{children}</div>
      <div className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}

export type CheckpointIconProps = ComponentProps<"span"> & { children?: ReactNode };

export function CheckpointIcon({ className, children, ...props }: CheckpointIconProps) {
  return (
    <span className={cn("flex items-center text-text-dim", className)} {...props}>
      {children ?? <BookmarkIcon className="size-3.5" />}
    </span>
  );
}

export type CheckpointTriggerProps = ComponentProps<typeof Button> & { tooltip?: string };

export function CheckpointTrigger({
  variant = "ghost",
  size = "sm",
  className,
  tooltip,
  children,
  ...props
}: CheckpointTriggerProps) {
  return (
    <Button
      variant={variant}
      size={size}
      title={tooltip}
      className={cn("h-6 gap-1.5 px-2 text-[11px]", className)}
      {...props}
    >
      {children}
    </Button>
  );
}
