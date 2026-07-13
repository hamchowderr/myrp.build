/**
 * Thumbs up/down feedback on a completed generation.
 *
 * Renders under the last assistant message once generation finishes. The rating
 * is sent to main (`feedback:rate`) which updates the generation_logs row — the
 * implicit/explicit quality signal that seeds the fine-tune dataset.
 */

import { MessageAction, MessageActions } from "@renderer/components/ai-elements/message";
import { cn } from "@renderer/lib/utils";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";

export function FeedbackActions({ generationId }: { generationId: string }) {
  const [rating, setRating] = useState<"up" | "down" | null>(null);

  const rate = (next: "up" | "down"): void => {
    if (rating) return; // one rating per generation
    setRating(next);
    void window.api.feedback.rate(generationId, next);
  };

  return (
    <MessageActions className="mt-1 px-1">
      <MessageAction
        tooltip="Good result"
        onClick={() => rate("up")}
        aria-pressed={rating === "up"}
      >
        <ThumbsUp className={cn("size-4", rating === "up" && "text-emerald-500")} />
      </MessageAction>
      <MessageAction
        tooltip="Bad result"
        onClick={() => rate("down")}
        aria-pressed={rating === "down"}
      >
        <ThumbsDown className={cn("size-4", rating === "down" && "text-red-500")} />
      </MessageAction>
      {rating && <span className="ml-1 text-xs text-muted-foreground">Thanks!</span>}
    </MessageActions>
  );
}
