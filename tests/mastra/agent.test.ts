import { resolve } from "node:path";
import { TokenLimiter } from "@mastra/core/processors";
import type { Workspace } from "@mastra/core/workspace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFiveMAgent } from "../../src/main/mastra/agent";
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

  // The point of this test: prove the harness wiring + that the
  // `anthropic/*` magic string resolves and routes through ANTHROPIC_BASE_URL
  // (the question deferred from 55x.3). A plain-text fixture keeps it free of
  // tool-call fixtures — those come with the runGeneration tests (55x.21).
  it("resolves the anthropic model and streams a mocked response", async () => {
    const agent = createFiveMAgent(ws);
    const result = await agent.stream("ping");
    const text = await result.text;
    expect(text).toContain("pong");
  });

  it("wires a TokenLimiter input processor (55x.9 context-window cap)", async () => {
    const agent = createFiveMAgent(ws);
    const procs = await agent.listConfiguredInputProcessors();
    expect(procs.some((p) => p instanceof TokenLimiter)).toBe(true);
  });

  it("is single-agent by default (no sub-agents)", async () => {
    const agent = createFiveMAgent(ws);
    const subAgents = await agent.listAgents();
    expect(Object.keys(subAgents ?? {})).toHaveLength(0);
  });

  it("wires the 7 specialist sub-agents when opted in (55x.24)", async () => {
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
