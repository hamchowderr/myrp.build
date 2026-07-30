/**
 * Rolling Anthropic prompt-cache breakpoint for the supervisor loop (5o2.2).
 *
 * !!! MEASURED 2026-07-29: processInputStep IS NEVER CALLED. Two independent
 * probes agree — an env-gated console.log printed nothing across a 4-step run,
 * and making the method throw produced no error. So this processor is currently
 * DEAD CODE and the rolling breakpoint it describes does not exist at runtime.
 * The prompt-cache hits observed live (25,395 of 25,398 tokens read from cache)
 * come from the SYSTEM-message ephemeral marker in agent-config.ts, not from
 * here. Do not cite this file as evidence the conversation prefix is cached.
 * Why it isn't invoked is not yet known (it is registered in `inputProcessors`
 * alongside TokenLimiter, whose own processInputStep does run). Tracked on
 * myrp-build-mg6; the class is kept, unmodified in behaviour, so the fix is a
 * wiring change rather than a rewrite.
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
 *
 * MUTATES IN PLACE AND RETURNS VOID. That is load-bearing, not stylistic — see the
 * long note in processInputStep. Returning the message array from a per-step
 * processor makes Mastra rebuild the whole MessageList and was the mechanism behind
 * myrp-build-mg6 (context frozen, the same file written 49 times).
 */
import type { ProcessInputStepArgs, Processor } from "@mastra/core/processors";

const EPHEMERAL = { type: "ephemeral" as const };

export class RollingCacheBreakpoint implements Processor<"rolling-cache-breakpoint"> {
  readonly id = "rolling-cache-breakpoint" as const;
  readonly name = "Rolling Cache Breakpoint";

  async processInputStep(args: ProcessInputStepArgs): Promise<void> {
    const messages = args.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    // Diagnostic for myrp-build-mg6 (MYRP_DEBUG_STEP_MESSAGES=1). This processor
    // is known to run on every step, so it is the cheapest honest probe of what
    // the MessageList actually holds BEFORE the prompt is built. If the roles here
    // include the tool results but the provider request does not, the loss is at
    // prompt-build time (filterIncompleteToolCalls); if they are already missing,
    // the loop itself dropped them.
    if (process.env.MYRP_DEBUG_STEP_MESSAGES === "1") {
      // biome-ignore lint/suspicious/noConsole: this IS the diagnostic artifact.
      console.log(`[step-messages] n=${messages.length} roles=${messages.map((m) => m.role).join(",")}`);
    }

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
    // RETURN NOTHING — deliberately. `args.messages` IS the MessageList's own
    // internal array (runProcessInputStep passes `messageList.get.all.db()`
    // straight through, and that getter returns `this.messages`), so the mutation
    // above has ALREADY landed. Returning the array is not a no-op: Mastra
    // normalizes an array result to `{ messages }` and hands it to
    // `applyMessagesToMessageList`, which treats it as the AUTHORITATIVE complete
    // list — it deletes any id missing from it, then removes and re-adds EVERY
    // message with `{ merge: false }`, re-tagging each one via `check.getSource()`.
    // Two ways that bites (myrp-build-mg6):
    //  1. Re-tagged messages whose source can no longer be resolved fall back to
    //     `defaultSource: "input"` — assistant/tool rows come back as USER rows.
    //     `filterIncompleteToolCalls` (MessageList default TRUE) then drops, at
    //     every prompt build, any tool-result whose preceding message isn't its
    //     matching assistant tool-call. The list keeps growing while the PROMPT
    //     stays frozen — which is exactly the 49-identical-writes failure.
    //  2. It runs last, after the TokenLimiter, and the array it was handed is
    //     the PRE-trim snapshot — so returning it re-inserts everything the
    //     TokenLimiter just removed, silently undoing the context cap.
    // `void` is the safe contract, and it is what Mastra's own per-step
    // processors use (TokenLimiter returns void; ToolCallFilter returns `{}`).
  }
}
