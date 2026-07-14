import { resolve } from "node:path";
import { RegexFilterProcessor, TokenLimiter, ToolCallFilter } from "@mastra/core/processors";
import type { Workspace } from "@mastra/core/workspace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFiveMAgent } from "../../src/main/mastra/agent";
import { RollingCacheBreakpoint } from "../../src/main/mastra/rolling-cache";
import { createFiveMWorkspace } from "../../src/main/mastra/workspace";
import { setupAimock } from "../setup/aimock";

// Starts the mock LLM server and points Mastra's anthropic provider at it.
setupAimock();

const RESOURCES = resolve(process.cwd(), "tests/fixtures/server/resources");

describe("FiveM supervisor agent via AIMock", () => {
  let ws: Workspace;

  beforeAll(async () => {
    ws = createFiveMWorkspace(RESOURCES);
    await ws.init();
  });

  afterAll(async () => {
    await ws.destroy();
  });

  // The point of this test: prove the harness wiring + that the model resolves
  // and routes through OPENAI_BASE_URL → AIMock (OpenAI Chat Completions, its
  // native protocol). A plain-text fixture keeps it free of tool-call fixtures —
  // those come with the runGeneration tests.
  it("resolves the anthropic model and streams a mocked response", async () => {
    const agent = createFiveMAgent(ws);
    const result = await agent.stream("ping");
    const text = await result.text;
    expect(text).toContain("pong");
  });

  it("wires a TokenLimiter input processor (context-window cap)", async () => {
    const agent = createFiveMAgent(ws);
    const procs = await agent.listConfiguredInputProcessors();
    expect(procs.some((p) => p instanceof TokenLimiter)).toBe(true);
  });

  it("wires the guardrail + memory + cache input processors", async () => {
    const agent = createFiveMAgent(ws);
    const procs = await agent.listConfiguredInputProcessors();
    // aku: deterministic dangerous-shell block. sop: strip recalled tool payloads.
    // 5o2.2: rolling Anthropic cache breakpoint.
    expect(procs.some((p) => p instanceof RegexFilterProcessor)).toBe(true);
    expect(procs.some((p) => p instanceof ToolCallFilter)).toBe(true);
    expect(procs.some((p) => p instanceof RollingCacheBreakpoint)).toBe(true);
  });

  it("orders the cache breakpoint AFTER the token limiter (marks post-trim tail)", async () => {
    const agent = createFiveMAgent(ws);
    const procs = await agent.listConfiguredInputProcessors();
    const limiterIdx = procs.findIndex((p) => p instanceof TokenLimiter);
    const cacheIdx = procs.findIndex((p) => p instanceof RollingCacheBreakpoint);
    expect(limiterIdx).toBeGreaterThanOrEqual(0);
    expect(cacheIdx).toBeGreaterThan(limiterIdx);
  });

  it("is single-agent by default (no sub-agents)", async () => {
    const agent = createFiveMAgent(ws);
    const subAgents = await agent.listAgents();
    expect(Object.keys(subAgents ?? {})).toHaveLength(0);
  });

  it("wires the 7 specialist sub-agents when opted in", async () => {
    const agent = createFiveMAgent(ws, { useSubAgents: true });
    const subAgents = await agent.listAgents();
    expect(Object.keys(subAgents ?? {}).sort()).toEqual(
      [
        "context-scout",
        "docs-writer",
        "lore-specialist",
        "lua-specialist",
        "nui-specialist",
        "security-auditor",
        "validator",
      ].sort(),
    );
  });
});
