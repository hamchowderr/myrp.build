import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { WORKSPACE_TOOLS } from "@mastra/core/workspace";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHarnessRuntime,
  disposeHarnessRuntime,
  type HarnessRuntime,
  sendHarnessTurn,
} from "../../src/main/mastra/chat-harness";
import { setupAimock } from "../setup/aimock";

/**
 * What the SUPERVISOR is actually offered, asserted against the real request
 * payload rather than our config object — the config is what we intended, the
 * payload is what the model sees, and only the second one decides behaviour.
 *
 * AIMock keeps no request journal, so a logging proxy sits in front of it. That
 * technique is the reason this file exists: it is how the delegation
 * investigation established that `subagent` was offered all along and the
 * problem lay elsewhere.
 *
 * Scope note: an earlier version also asserted the supervisor had NO write tools.
 * That change is reverted — see the note on SUPERVISOR_TOOLS — because removing
 * them stopped direct writes without producing delegation, so the agent wrote
 * nothing at all. What is asserted here is the surface delegation DEPENDS on,
 * which is a real regression risk regardless of how the delegation problem is
 * eventually solved.
 */
const getAimock = setupAimock();

const captured: Array<Record<string, unknown>> = [];
let proxy: Server;

function localStore(): MastraCompositeStore {
  return new MastraCompositeStore({
    id: "supervisor-scope",
    domains: {
      memory: new InMemoryStore().stores.memory,
      workflows: new InMemoryStore().stores.workflows,
    },
  });
}

/** Tool names in the first captured completions request. */
function offeredTools(): string[] {
  const body = captured[0];
  const tools = (body?.tools ?? []) as Array<Record<string, unknown>>;
  return tools.map((t) => (t.function as { name?: string } | undefined)?.name ?? String(t.name));
}

describe("supervisor tool scope", () => {
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

    root = mkdtempSync(join(tmpdir(), "sup-scope-"));
    runtime = await buildHarnessRuntime(root, {
      key: "scope",
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

  it("keeps delegation, planning and read access", async () => {
    await sendHarnessTurn(runtime, { text: "make manifest", send: () => {} });
    const names = offeredTools();

    // Losing `subagent` would make delegation impossible rather than merely
    // unattractive, and the failure would look identical to the one being
    // investigated — so assert it is present regardless of that outcome.
    expect(names).toContain("subagent");
    expect(names).toContain("task_write");
    expect(names).toContain("task_complete");
    expect(names).toContain(WORKSPACE_TOOLS.FILESYSTEM.READ_FILE);
    expect(names).toContain(WORKSPACE_TOOLS.SEARCH.SEARCH);
    expect(names).toContain("validate_resource");
  }, 120_000);
});
