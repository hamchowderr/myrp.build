import type { HarnessContentPart, HarnessMessage } from "./events";

/**
 * Since @mastra/core 1.8x a logical message streams as ONE `message_start`
 * (the initial `MastraDBMessage`), then compact id-addressed `message_update`
 * deltas, then an id-only `message_end`. Older runtimes re-sent the whole
 * message on every update. This folds one delta into the matching message so
 * the rest of the renderer keeps seeing whole messages.
 */
export type MessageDelta =
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; index: number; delta: string }
  | { type: "part"; index: number; part: HarnessContentPart };

function appendText(parts: HarnessContentPart[], delta: string): HarnessContentPart[] {
  const last = parts.at(-1);
  if (last?.type === "text" && typeof last.text === "string") {
    return [...parts.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...parts, { type: "text", text: delta }];
}

function appendReasoning(
  parts: HarnessContentPart[],
  index: number,
  delta: string,
): HarnessContentPart[] {
  const next = parts.slice();
  const cur = next[index] as { type?: string; text?: unknown } | undefined;
  const text = typeof cur?.text === "string" ? cur.text : "";
  next[index] = {
    ...(cur ?? { type: "reasoning" }),
    type: cur?.type ?? "reasoning",
    text: text + delta,
  };
  return next;
}

export function applyMessageDelta(message: HarnessMessage, delta: MessageDelta): HarnessMessage {
  switch (delta.type) {
    case "text-delta":
      return { ...message, content: appendText(message.content, String(delta.delta ?? "")) };
    case "reasoning-delta":
      return {
        ...message,
        content: appendReasoning(message.content, delta.index, String(delta.delta ?? "")),
      };
    case "part": {
      const content = message.content.slice();
      content[delta.index] = delta.part;
      return { ...message, content };
    }
    default:
      return message;
  }
}

/**
 * 1.8x echoes the user's turn as a `signal` message carrying a
 * `data-user-message` part instead of a role=user text message. Normalise it so
 * the optimistic-placeholder swap and the user bubble keep working; any other
 * signal passes through unchanged.
 */
export function normaliseSignalMessage(message: HarnessMessage): HarnessMessage {
  if ((message.role as string) !== "signal") return message;
  const part = message.content.find((p) => p.type === "data-user-message") as
    | { data?: { type?: string; contents?: unknown } }
    | undefined;
  if (part?.data?.type !== "user" || typeof part.data.contents !== "string") return message;
  return { ...message, role: "user", content: [{ type: "text", text: part.data.contents }] };
}
