/**
 * LIVE verification for 5o2.2 — rolling conversation prompt caching.
 *
 * This is NOT part of the free/mocked tiers: it makes a REAL multi-step
 * generation through the Vercel AI Gateway → Anthropic, so it is guarded by
 * `skipIf` on the gateway key and skips cleanly in `npm run test` (no key).
 *
 * Run it explicitly with the key injected:
 *   infisical run --path=/myrp-build --env=dev -- npx vitest run tests/live/rolling-cache.live.test.ts
 *   (from PowerShell — Git Bash mangles the leading-slash --path.)
 *
 * The tell for the rolling breakpoint working is per-step `usage.cachedInputTokens`
 * (cache READ) that GROWS across the loop — a system-only cache would stay ~flat at
 * the instructions/RAG size, whereas caching the conversation prefix makes the read
 * count climb as the conversation grows. We log the full table and assert a cache
 * read appears on step 2+.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Workspace } from "@mastra/core/workspace";
import { afterAll, describe, expect, it } from "vitest";
import { createFiveMAgent } from "../../src/main/mastra/agent";
import { createFiveMWorkspace } from "../../src/main/mastra/workspace";

const GATEWAY_KEY = process.env.VERCEL_GATEWAY_KEY ?? process.env.AI_GATEWAY_API_KEY;

// A prompt that forces several tool-producing steps (each write is a step), so the
// conversation actually grows and there is a prefix worth caching on step 2+.
const PROMPT =
  "Create a new ox_lib resource named cachetest in its own folder. Write two files " +
  "with the filesystem tools: (1) fxmanifest.lua with fx_version 'cerulean', game 'gta5', " +
  "and a client_script of client/main.lua; (2) client/main.lua that registers a chat " +
  "command '/ping' which prints 'pong'. Write each file, then briefly confirm you are done.";

interface StepMetric {
  step: number;
  inputTokens: number | undefined;
  cachedRead: number | undefined;
  cacheCreation: number | undefined;
}

/** Drive one generation and pull per-step token metrics off the result. */
async function generate(): Promise<StepMetric[]> {
  const dir = mkdtempSync(join(tmpdir(), "myrp-cache-"));
  const ws: Workspace = createFiveMWorkspace(resolve(dir), { requireApproval: false });
  await ws.init();
  try {
    const agent = createFiveMAgent(ws, { resourcesRoot: resolve(dir) });
    const result = await agent.stream(PROMPT);
    // Drain the stream so the whole multi-step loop (incl. tool execution) finishes.
    await result.text;
    const steps = await result.steps;
    return steps.map((s, i) => {
      // biome-ignore lint/suspicious/noExplicitAny: provider metadata is loosely typed across providers.
      const anthropic = (s.providerMetadata as any)?.anthropic ?? {};
      return {
        step: i + 1,
        inputTokens: s.usage?.inputTokens,
        // AI SDK v5 standardized cache-read counter (maps to Anthropic cache_read_input_tokens).
        cachedRead: s.usage?.cachedInputTokens,
        // Anthropic-specific cache WRITE for this step.
        cacheCreation: anthropic.cacheCreationInputTokens ?? anthropic.cache_creation_input_tokens,
      };
    });
  } finally {
    await ws.destroy().catch(() => {});
  }
}

describe.skipIf(!GATEWAY_KEY)("5o2.2 live — rolling conversation cache", () => {
  let metrics: StepMetric[] = [];

  afterAll(() => {
    // Surface the evidence in the test output regardless of pass/fail.
    // biome-ignore lint/suspicious/noConsole: this IS the verification artifact.
    console.table(metrics);
  });

  it("reads the cached prefix on step 2+ (cachedInputTokens > 0)", async () => {
    metrics = await generate();
    expect(metrics.length).toBeGreaterThan(1);

    const laterSteps = metrics.slice(1);
    const maxRead = Math.max(...laterSteps.map((m) => m.cachedRead ?? 0));
    // Acceptance: a cache read is observed on step 2+.
    expect(maxRead).toBeGreaterThan(0);
  }, 120_000);
});
