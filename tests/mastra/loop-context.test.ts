import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_STEPS } from "../../src/main/mastra/agent-config";
import {
  buildHarnessRuntime,
  disposeHarnessRuntime,
  type HarnessRuntime,
  sendHarnessTurn,
} from "../../src/main/mastra/chat-harness";
import { setupAimock } from "../setup/aimock";

/**
 * The agentic loop's two invariants, asserted against the REAL provider requests
 * rather than against config — because both of these were config-correct and
 * behaviourally broken at the same time (myrp-build-mg6 / myrp-build-5fi).
 *
 * WHY THIS FILE EXISTS. Every other fixture we own is TWO steps, so nothing
 * covered step 3 onward. A live /ping generation then ran 53 steps, wrote the
 * SAME file 49 times, never reached fxmanifest.lua, and burned 1.29M tokens —
 * because per-step input was frozen (the model could not see it had already
 * written the file) and nothing bounded the loop. A two-step test cannot see
 * either failure: at step 2 there is nothing to accumulate yet, and 2 is under
 * any budget. Hence a multi-step chain here.
 *
 * The `toolCallId` fixture matcher is what makes the first test meaningful: it
 * matches only when the LAST message is that tool's result. So the chain
 * advancing at all IS the proof that each step's tool result reached the model.
 * If context stops accumulating, the request falls back to the leg-1
 * (`hasToolResult: false`) fixture and re-issues the FIRST write — reproducing
 * the 49-identical-writes failure as a duplicate path instead of a hang.
 */
const getAimock = setupAimock();

const captured: Array<Record<string, unknown>> = [];
let proxy: Server;

function localStore(): MastraCompositeStore {
  return new MastraCompositeStore({
    id: "loop-context",
    domains: {
      memory: new InMemoryStore().stores.memory,
      workflows: new InMemoryStore().stores.workflows,
    },
  });
}

/** Messages array of the Nth captured completions request. */
function messagesOf(index: number): Array<Record<string, unknown>> {
  return (captured[index]?.messages ?? []) as Array<Record<string, unknown>>;
}

/**
 * Human-readable summary of any error/failed-tool events, or "" when clean.
 * Without this a failing tool looks identical to a correctly-bounded loop.
 */
function errorSummary(events: Array<Record<string, unknown>>): string {
  const bad = events.filter(
    (e) => e.type === "error" || e.type === "workspace_error" || e.type === "tool_error",
  );
  const toolFailures = events
    .filter((e) => e.type === "tool_end" && e.isError)
    .map((e) => `tool_end(error): ${JSON.stringify(e.result ?? e.error).slice(0, 300)}`);
  return [...bad.map((e) => `${e.type}: ${JSON.stringify(e.error ?? e)}`), ...toolFailures].join(
    " | ",
  );
}

/**
 * Every `write_file` path in ONE request's message history, in order.
 *
 * Defaults to the LAST request, which is the only meaningful one: when the loop
 * works correctly each request REPEATS the whole prior history, so scanning all
 * captured requests reports `[main, main, config, main, config, manifest]` for a
 * perfectly healthy 3-file run and any uniqueness check on it fails by
 * construction. The final request holds the complete history exactly once.
 */
function writtenPaths(index = captured.length - 1): string[] {
  const paths: string[] = [];
  const body = captured[index];
  if (body) {
    for (const m of (body.messages ?? []) as Array<Record<string, unknown>>) {
      const calls = (m.tool_calls ?? []) as Array<{ function?: { arguments?: string } }>;
      for (const c of calls) {
        const raw = c.function?.arguments;
        if (typeof raw !== "string") continue;
        try {
          const args = JSON.parse(raw) as { path?: string };
          if (args.path) paths.push(args.path);
        } catch {
          /* non-JSON tool args */
        }
      }
    }
  }
  return paths;
}

describe("agentic loop context + step budget", () => {
  let root: string;
  let runtime: HarnessRuntime;

  beforeEach(async () => {
    captured.length = 0;
    const upstream = getAimock().url;
    proxy = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          captured.push(JSON.parse(raw));
        } catch {
          /* not a JSON completions body */
        }
        const up = await fetch(`${upstream}${req.url}`, {
          method: req.method,
          headers: { "Content-Type": "application/json" },
          body: raw || undefined,
        });
        const text = await up.text();
        res.writeHead(up.status, { "Content-Type": "application/json" });
        res.end(text);
      });
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const port = (proxy.address() as { port: number }).port;
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;

    root = mkdtempSync(join(tmpdir(), "loop-ctx-"));
    runtime = await buildHarnessRuntime(root, {
      key: "loop-ctx",
      resourceId: "ws_t__srv_t",
      storage: localStore(),
      requireApproval: false,
    });
  }, 60_000);

  afterEach(async () => {
    await disposeHarnessRuntime(runtime);
    await new Promise<void>((r) => proxy.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  // REGRESSION GUARD for myrp-build-mg6, which was an UPSTREAM defect:
  // mastra-ai/mastra#19814, fixed by porting PR #19940 onto the published bundle
  // (patches/@mastra+core+*.patch). Was `it.fails` while the bug was live.
  //
  // The failure this locks down: requests alternated `system,user` /
  // `system,user,assistant+tc,tool`, so every second model call had its history
  // reset and the agent re-issued its FIRST write — 49 identical writes and 1.29M
  // tokens on a one-command resource. Root cause was resume hydration, not our
  // pipeline: `#validateSuspendedToolCallTarget` polled for the snapshot holding
  // the target suspension, then threw it away, so `resumeStream` rehydrated
  // MessageList from the STALE snapshot and lost the second tool result.
  //
  // Ruled out by A/B before finding it, all with the alternation unchanged:
  // RollingCacheBreakpoint (MYRP_DISABLE_ROLLING_CACHE=1), ToolCallFilter
  // (MYRP_DISABLE_TOOL_CALL_FILTER=1), TokenLimiter (150k, never trims here),
  // and memory (none configured). If this test fails again after a
  // @mastra/core bump, check the patch still applied before suspecting our code.
  it("carries each step's tool result into the next request", async () => {
    const events: Array<Record<string, unknown>> = [];
    await sendHarnessTurn(runtime, {
      text: "build the multistep resource",
      send: (e) => events.push(e as unknown as Record<string, unknown>),
    });
    // Roles per request are the fastest read on a context bug: assistant
    // tool_calls surviving while `tool` results vanish is a different failure
    // from the whole history being dropped.
    const roles = () =>
      captured.map((_, i) =>
        messagesOf(i)
          .map((m) => (m.tool_calls ? `${m.role}+tc` : String(m.role)))
          .join(","),
      );
    const diag = () =>
      `requests=${captured.length} paths=${JSON.stringify(writtenPaths())} roles=${JSON.stringify(
        roles(),
      )} evt=${JSON.stringify(events.map((e) => e.type).filter((t) => !String(t).includes("display_state")))} errors=${errorSummary(events)}`;

    expect(errorSummary(events), diag()).toBe("");

    // Four model calls: three writes chained on the previous result, then text.
    // More than four means the chain restarted; fewer means it stalled early.
    expect(captured.length, diag()).toBe(4);

    // The direct signature of the bug: every SECOND request arrives with the
    // history reset to system+user, so the model never sees its own tool result.
    // Asserted explicitly because the count above can be wrong for other reasons.
    const withToolResult = captured.filter((_, i) =>
      messagesOf(i).some((m) => m.role === "tool"),
    ).length;
    expect(withToolResult, diag()).toBe(3);

    // Context must GROW — a frozen message count is the mg6 signature.
    const counts = captured.map((_, i) => messagesOf(i).length);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThan(counts[i - 1]);
    }

    // The final request must still carry the EARLIEST tool result, not just the
    // most recent one — that is what lets the model know what it already did.
    const finalSerialized = JSON.stringify(messagesOf(captured.length - 1));
    expect(finalSerialized).toContain("[local]/multistep/server/main.lua");
    expect(finalSerialized).toContain("[local]/multistep/shared/config.lua");

    // Each file is written exactly once. Duplicates ARE the live failure.
    const paths = writtenPaths();
    expect(new Set(paths).size).toBe(paths.length);
  }, 120_000);

  // EXPERIMENT for myrp-build-mg6 / mastra-ai#19814. The upstream report says the
  // lost tool result requires a NON-yolo controller: `buildSharedRunOptions()` sets
  // `requireToolApproval: !isYolo`, so with yolo off every call raises an approval
  // chunk — which the controller silently consumes and self-approves for any tool
  // whose effective policy is already `allow` (ours: the whole `edit` category).
  // That self-approval goes through resume, and resume is where the result is lost.
  // `session.state.set({ yolo: true })` short-circuits `resolveToolApproval` to
  // "allow" before the gate, so no approval chunk and no resume. Same fixture as
  // the reproduction above — the ONLY difference is yolo.
  it("carries tool results when the session is yolo", async () => {
    await runtime.session.state.set({ yolo: true });
    const events: Array<Record<string, unknown>> = [];
    await sendHarnessTurn(runtime, {
      text: "build the multistep resource",
      send: (e) => events.push(e as unknown as Record<string, unknown>),
    });
    const roles = () =>
      captured.map((_, i) =>
        messagesOf(i)
          .map((m) => (m.tool_calls ? `${m.role}+tc` : String(m.role)))
          .join(","),
      );
    const diag = `requests=${captured.length} paths=${JSON.stringify(writtenPaths())} roles=${JSON.stringify(roles())} errors=${errorSummary(events)}`;

    expect(errorSummary(events), diag).toBe("");
    expect(captured.length, diag).toBe(4);
    const withToolResult = captured.filter((_, i) =>
      messagesOf(i).some((m) => m.role === "tool"),
    ).length;
    expect(withToolResult, diag).toBe(3);
    const paths = writtenPaths();
    expect(new Set(paths).size, diag).toBe(paths.length);
  }, 120_000);

  it("stops at the step budget instead of running away", async () => {
    // This fixture matches EVERY request and always answers with a tool call, so
    // only the loop budget can end it. Before the stopWhen fix the AgentController
    // replaced our maxSteps with its own hardcoded 1000.
    // NB: fixture `userMessage` matching is SUBSTRING, and basic.json registers a
    // matcher of just "ping" — so any prompt containing those three letters
    // (e.g. "stopping") is silently answered by that fixture instead. Keep this
    // prompt clear of every other fixture's match string.
    const events: Array<Record<string, unknown>> = [];
    await sendHarnessTurn(runtime, {
      text: "keep listing forever",
      send: (e) => events.push(e as unknown as Record<string, unknown>),
    });

    const diag = `requests=${captured.length} MAX_STEPS=${MAX_STEPS} errors=${errorSummary(events)}`;

    // It must stop because the BUDGET tripped, not because something errored —
    // a failing tool also ends the loop early and must not read as "bounded".
    expect(errorSummary(events), diag).toContain("Step budget reached");
    // MAX_STEPS + 1 because the breaker trips on exceeding the budget, so one
    // extra call lands before the abort takes effect.
    expect(captured.length, diag).toBeLessThanOrEqual(MAX_STEPS + 1);
    // Guard against the opposite failure: a budget so eager it never loops.
    expect(captured.length, diag).toBeGreaterThan(1);
  }, 180_000);
});
