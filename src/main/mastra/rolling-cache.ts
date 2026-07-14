/**
 * Rolling Anthropic prompt-cache breakpoint for the supervisor loop (5o2.2).
 *
 * The supervisor re-sends the whole growing conversation on every step (up to 30);
 * tool results carry large file contents, so each step re-pays full input-token
 * price for the same prefix. The system message already carries an ephemeral cache
 * marker (agent-config.ts) — but the CONVERSATION below it is uncached, and it's
 * the part that grows.
 *
 * This input processor stamps an ephemeral `cacheControl` marker on the LAST
 * message before each step. Anthropic caches the prefix up to a breakpoint, so on
 * the next step the request finds the previous step's breakpoint and reads the
 * whole conversation prefix from cache (observable as cache_read_input_tokens > 0
 * on step 2+). Because the marker rides the last message, the breakpoint advances
 * every step — a "rolling" cache that keeps extending as the conversation grows.
 *
 * ORDERING: this MUST run AFTER the TokenLimiter (which also runs per step). When
 * the TokenLimiter trims the oldest messages the cached prefix changes, so that one
 * step is a cache MISS — unavoidable and acceptable. Running last means we always
 * mark the post-trim last message.
 *
 * The marker is namespaced under `anthropic`, so non-Anthropic providers ignore it.
 * It never throws: on any unexpected message shape it leaves the messages untouched
 * so a caching tweak can never break a generation.
 */
import type { MastraDBMessage } from "@mastra/core/agent/message-list";
import type { ProcessInputStepArgs, Processor } from "@mastra/core/processors";

const EPHEMERAL = { type: "ephemeral" as const };

export class RollingCacheBreakpoint implements Processor<"rolling-cache-breakpoint"> {
  readonly id = "rolling-cache-breakpoint" as const;
  readonly name = "Rolling Cache Breakpoint";

  async processInputStep(args: ProcessInputStepArgs): Promise<MastraDBMessage[] | void> {
    const messages = args.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const last = messages[messages.length - 1];
    if (!last?.content) return;

    // Preserve any other provider metadata; add/overwrite only the anthropic
    // cache marker on the last message's content (the Anthropic provider applies
    // it to that message's final content block → the rolling prefix breakpoint).
    const existing = last.content.providerMetadata ?? {};
    last.content = {
      ...last.content,
      providerMetadata: {
        ...existing,
        anthropic: { ...(existing.anthropic ?? {}), cacheControl: EPHEMERAL },
      },
    };
    return messages;
  }
}
