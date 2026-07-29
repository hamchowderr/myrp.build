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
 * Guards the fix for the first real generation, where the supervisor wrote the
 * files itself instead of delegating: `subagent` was offered and the prompt said
 * to use it, but write_file was offered too, so it took the direct path. With no
 * write tools, delegation is the only way for anything to reach disk.
 *
 * AIMock keeps no request journal, so a logging proxy sits in front of it.
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

  it("offers the supervisor NO way to write files itself", async () => {
    await sendHarnessTurn(runtime, { text: "make manifest", send: () => {} });
    const names = offeredTools();
    expect(names.length).toBeGreaterThan(0);

    for (const write of [
      WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE,
      WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE,
      WORKSPACE_TOOLS.FILESYSTEM.MKDIR,
      WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT,
    ]) {
      expect(names).not.toContain(write);
    }
  }, 120_000);

  it("keeps delete and shell, which no specialist holds", async () => {
    // sub-agents.ts grants specialists only READ_TOOLS + WRITE_TOOLS, so pulling
    // these from the supervisor as well would leave them reachable by nobody and
    // silently kill cleanup, the delete approval gate, and shell-run checks.
    await sendHarnessTurn(runtime, { text: "make manifest", send: () => {} });
    const names = offeredTools();
    expect(names).toContain(WORKSPACE_TOOLS.FILESYSTEM.DELETE);
    expect(names).toContain(WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND);
  }, 120_000);

  it("keeps delegation, planning and read access", async () => {
    await sendHarnessTurn(runtime, { text: "make manifest", send: () => {} });
    const names = offeredTools();

    // Without `subagent` nothing can be built at all — the supervisor can no
    // longer write, so this tool is now load-bearing rather than merely advised.
    expect(names).toContain("subagent");
    expect(names).toContain("task_write");
    expect(names).toContain("task_complete");
    expect(names).toContain(WORKSPACE_TOOLS.FILESYSTEM.READ_FILE);
    expect(names).toContain(WORKSPACE_TOOLS.SEARCH.SEARCH);
    expect(names).toContain("validate_resource");
  }, 120_000);
});
