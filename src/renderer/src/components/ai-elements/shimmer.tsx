import { cn } from "@renderer/lib/utils";
import type { CSSProperties, ElementType } from "react";
import { memo, useMemo } from "react";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

/**
 * Animated text shimmer (e.g. the "Thinking…" label). Pure CSS — the `.text-shimmer`
 * class in index.css animates a highlight gradient across the text via
 * background-position. Replaces the previous motion/framer-motion implementation,
 * which pulled ~370KB into the startup bundle for this one effect.
 *
 * API is unchanged: `spread` scales the highlight width with text length, and
 * `duration` sets the loop time — both passed through as CSS custom properties.
 */
const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = useMemo(() => (children?.length ?? 0) * spread, [children, spread]);

  return (
    <Component
      className={cn("text-shimmer", className)}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          "--shimmer-duration": `${duration}s`,
        } as CSSProperties
      }
    >
      {children}
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
