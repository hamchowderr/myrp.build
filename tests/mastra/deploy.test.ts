import dgram from "node:dgram";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toAISdkStream } from "@mastra/ai-sdk";
import type { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import type { MastraModelOutput } from "@mastra/core/stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFiveMAgent } from "../../src/main/mastra/agent";
import { createFiveMWorkspace } from "../../src/main/mastra/workspace";
import { setupAimock } from "../setup/aimock";

// deploy-resource fixture drives a deploy_resource tool call.
setupAimock();

const AGENT_KEY = "fivem-generator";
const PROMPT = "deploy the carwash resource";

const OOB = Buffer.from([0xff, 0xff, 0xff, 0xff]);

/**
 * Mock FiveM server: HTTP 200 on /info.json (the deploy tool's reachability ping)
 * + a UDP socket that speaks the OOB RCON protocol (0xFFFFFFFF + "rcon <pw> <cmd>"),
 * records each command, and replies out-of-band so sendRconCommand resolves ok.
 */
function mockServer(): { http: Server; udp: dgram.Socket; commands: string[] } {
  const commands: string[] = [];
  const http = createServer((req, res) => {
    if (req.url === "/info.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ vars: { sv_hostname: "test" } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const udp = dgram.createSocket("udp4");
  udp.on("message", (msg, rinfo) => {
    const text = msg.subarray(OOB.length).toString("utf8");
    const m = text.match(/^rcon \S+ (.*)$/s);
    if (m) commands.push(m[1].trim());
    // Reply out-of-band (clean output -> loadSuccess) so the tool resolves.
    udp.send(Buffer.concat([OOB, Buffer.from("print ")]), rinfo.port, rinfo.address);
  });
  return { http, udp, commands };
}

/**
 * Bind the mock's TCP + UDP to the SAME free port (the deploy tool pings HTTP /info.json
 * and sends RCON over UDP on one port). `server.listen(0)` picks a free *TCP* port, but
 * that number can already be held on *UDP* by a parallel test file — the old code bound
 * UDP to it unconditionally and threw EADDRINUSE under concurrency (fivem-studio-46r).
 * Retry on a fresh ephemeral port until both protocols bind.
 */
async function bindMockOnFreePort(): Promise<{
  server: Server;
  udp: dgram.Socket;
  commands: string[];
  port: number;
}> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 25; attempt++) {
    const m = mockServer();
    try {
      const port = await new Promise<number>((res, rej) => {
        const onErr = (e: Error) => rej(e);
        m.http.once("error", onErr);
        m.http.listen(0, "127.0.0.1", () => {
          m.http.removeListener("error", onErr);
          res((m.http.address() as { port: number }).port);
        });
      });
      await new Promise<void>((res, rej) => {
        const onErr = (e: Error) => rej(e);
        m.udp.once("error", onErr);
        m.udp.bind(port, "127.0.0.1", () => {
          m.udp.removeListener("error", onErr);
          res();
        });
      });
      return { server: m.http, udp: m.udp, commands: m.commands, port };
    } catch (e) {
      lastErr = e;
      await new Promise<void>((r) => m.http.close(() => r()));
      try {
        m.udp.close();
      } catch {
        /* socket never bound — nothing to close */
      }
    }
  }
  throw new Error(
    `deploy.test: no shared free TCP+UDP port after 25 attempts (${String(lastErr)})`,
  );
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

describe("deploy_resource tool (445.2) — approval-gated ensure via RCON", () => {
  let server: Server | undefined;
  let udp: dgram.Socket | undefined;
  let port: number;
  let commands: string[];
  let root: string;

  beforeEach(async () => {
    // Set root FIRST so afterEach always has a path even if binding throws (the
    // TypeError: rmSync(undefined) symptom of fivem-studio-46r).
    root = mkdtempSync(join(tmpdir(), "fivem-deploy-"));
    ({ server, udp, commands, port } = await bindMockOnFreePort());
  });

  afterEach(async () => {
    if (udp) await new Promise<void>((r) => udp.close(() => r()));
    if (server) await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  function buildAgent(): { agent: Agent; destroy: () => Promise<void> } {
    const workspace = createFiveMWorkspace(root);
    const base = createFiveMAgent(workspace, {
      deployConfig: { port, rconPassword: "test-pw" },
    });
    const agent = new Mastra({
      storage: new InMemoryStore(),
      agents: { [AGENT_KEY]: base },
    }).getAgent(AGENT_KEY);
    return {
      agent,
      destroy: async () => void (await workspace.destroy().catch(() => {})),
    };
  }

  it("pauses for approval, then approve runs refresh + ensure <resource>", async () => {
    const { agent, destroy } = buildAgent();
    try {
      const out = await agent.stream(PROMPT);
      const runId = await pump(out);

      // Gated: must pause, and NO RCON command before approval.
      expect(runId).toBeTruthy();
      expect(commands).toEqual([]);

      await pump(await agent.approveToolCall({ runId: runId as string }));
      // Approved: refresh first (detect new files), then ensure the resource.
      expect(commands).toEqual(["refresh", "ensure carwash"]);
    } finally {
      await destroy();
    }
  });

  it("decline does not touch the server", async () => {
    const { agent, destroy } = buildAgent();
    try {
      const runId = await pump(await agent.stream(PROMPT));
      expect(runId).toBeTruthy();
      await pump(await agent.declineToolCall({ runId: runId as string }));
      expect(commands).toEqual([]);
    } finally {
      await destroy();
    }
  });
});
