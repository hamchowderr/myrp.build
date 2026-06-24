import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { cn } from "@renderer/lib/utils";
import type { ComponentProps } from "react";

export type SuggestionsProps = ComponentProps<typeof ScrollArea>;

export const Suggestions = ({ className, children, ...props }: SuggestionsProps) => (
  <ScrollArea className="w-full whitespace-nowrap" {...props}>
    <div className={cn("flex w-max flex-nowrap items-center gap-2", className)}>{children}</div>
  </ScrollArea>
);

export type SuggestionProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  /** The suggestion string to display and emit on click. */
  suggestion: string;
  /** Callback fired when the suggestion is clicked. */
  onClick?: (suggestion: string) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  variant = "outline",
  size = "sm",
  children,
  ...props
}: SuggestionProps) => (
  <Button
    className={cn("cursor-pointer rounded-full px-4", className)}
    onClick={() => onClick?.(suggestion)}
    size={size}
    type="button"
    variant={variant}
    {...props}
  >
    {children ?? suggestion}
  </Button>
);
