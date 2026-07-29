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
 * Scope note: an earlier version asserted the supervisor had NO write tools.
 * That is now inverted. The size gate (myrp-build-u1y) makes the supervisor the
 * intended author of SMALL builds, so write_file is a REQUIRED part of its
 * surface — see the note on SUPERVISOR_TOOLS. Both halves are asserted here:
 * the delegation surface a FULL build needs, and the authoring surface a SMALL
 * build needs. Each is a real regression risk, and they pull in opposite
 * directions, so neither is safe to leave unpinned.
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

/** Concatenated system-message text in the first captured completions request. */
function systemPrompt(): string {
  const messages = (captured[0]?.messages ?? []) as Array<Record<string, unknown>>;
  return messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
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

  // The SMALL lane instructs the supervisor to author the files itself. If a
  // future `availableTools` allowlist strips these, that instruction becomes
  // unfollowable and every one-command resource falls back to seven serial
  // specialists — the exact cost the size gate exists to remove.
  it("keeps the authoring tools the SMALL lane requires", async () => {
    await sendHarnessTurn(runtime, { text: "make manifest", send: () => {} });
    const names = offeredTools();

    expect(names).toContain(WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE);
    expect(names).toContain(WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE);
    expect(names).toContain(WORKSPACE_TOOLS.FILESYSTEM.MKDIR);
  }, 120_000);

  // Tools without the instruction is the pre-gate state: the supervisor wrote
  // files because it could, not because it had sized the build. Assert the rule
  // reaches the model, in the payload rather than by importing the constant.
  it("delivers the size gate in the system prompt", async () => {
    await sendHarnessTurn(runtime, { text: "make manifest", send: () => {} });
    const system = systemPrompt();

    expect(system).toContain("SIZE THE BUILD");
    expect(system).toContain("SMALL");
    expect(system).toContain("FULL");
    expect(system).toMatch(/WRITE THESE FILES YOURSELF/);
  }, 120_000);
});
