import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toAISdkStream } from "@mastra/ai-sdk";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import type { MastraModelOutput } from "@mastra/core/stream";
import { Memory } from "@mastra/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFiveMAgent } from "../../src/main/mastra/agent";
import { createFiveMWorkspace } from "../../src/main/mastra/workspace";
import { setupAimock } from "../setup/aimock";

// xqc.1 EXPERIMENT: does autoResumeSuspendedTools resume an APPROVAL-GATED tool
// (deploy_resource — no resumeSchema) from a natural-language follow-up on the
// same thread, instead of an explicit approveToolCall button?
setupAimock();

const AGENT_KEY = "fivem-generator";

function mockServer(): {
  server: Server;
  commands: string[];
  ready: Promise<void>;
} {
  const commands: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/info.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ vars: {} }));
      return;
    }
    if (req.url === "/rcon" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        commands.push(new URLSearchParams(body).get("command") ?? "");
        res.writeHead(200);
        res.end("ok");
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const ready = new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, commands, ready };
}

async function pump(output: MastraModelOutput): Promise<string | undefined> {
  let pausedRunId: string | undefined;
  const ui = toAISdkStream(output, {
    from: "agent",
    version: "v6",
    sendReasoning: true,
  });
  const reader = ui.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if ((value as { type?: string }).type === "tool-approval-request") pausedRunId = output.runId;
  }
  return pausedRunId;
}

describe("autoResumeSuspendedTools on approval-gated deploy (xqc.1)", () => {
  let server: Server;
  let commands: string[];
  let port: number;
  let root: string;

  beforeEach(async () => {
    const m = mockServer();
    server = m.server;
    commands = m.commands;
    await m.ready;
    port = (server.address() as { port: number }).port;
    root = mkdtempSync(join(tmpdir(), "fivem-resume-"));
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  it("does NOT resume an approval-gated tool from NL (needs explicit approveToolCall)", async () => {
    const workspace = createFiveMWorkspace(root);
    const storage = new InMemoryStore();
    const memory = new Memory({
      storage,
      options: { lastMessages: 20, semanticRecall: false },
    });
    const base = createFiveMAgent(workspace, {
      deployConfig: { port, rconPassword: "test-pw" },
      memory,
    });
    const agent = new Mastra({
      storage,
      agents: { [AGENT_KEY]: base },
    }).getAgent(AGENT_KEY);
    const thread = randomUUID();
    const mem = { memory: { thread, resource: "test-user" } };

    try {
      // Turn 1: triggers the gated deploy → pauses for approval.
      const runId = await pump(await agent.stream("deploy the carwash resource", mem));
      expect(runId).toBeTruthy();
      expect(commands).toEqual([]);

      // Turn 2: a natural-language "approval" on the SAME thread, autoResume on.
      await pump(
        await agent.stream("yes, go ahead and deploy it", {
          ...mem,
          autoResumeSuspendedTools: true,
        }),
      );

      // FINDING (xqc.1): autoResumeSuspendedTools does NOT resume an
      // approval-gated tool from natural language — `deploy_resource` uses the
      // requireApproval path and has no `resumeSchema`, which autoResume needs to
      // extract resumeData from the follow-up. The gated command never runs; the
      // only resume path for approval-gated tools is explicit approveToolCall.
      // Conversational resume would require redesigning gated tools around
      // suspend()/resumeSchema, or an app-side NL-intent -> approveToolCall bridge.
      expect(commands).toEqual([]);
    } finally {
      await workspace.destroy().catch(() => {});
    }
  });
});
