import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@mastra/core/agent-controller";
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HarnessWireEvent, runHarnessTurn } from "../../src/main/mastra/chat-harness";
import { createFiveMHarness } from "../../src/main/mastra/harness";
import { applyFiveMPermissions } from "../../src/main/mastra/permissions";
import { createFiveMWorkspace } from "../../src/main/mastra/workspace";
import { setupAimock } from "../setup/aimock";

/**
 * SAFETY GATE under yolo — the measurement that decides how myrp-build-mg6 is fixed.
 *
 * Yolo is the only thing that makes the agentic loop carry its own tool results
 * (measured in loop-context.test.ts; upstream mastra-ai#19814). The question this
 * file answers is what that costs: does yolo also un-gate the dangerous ops —
 * deploying to a live server, installing resources, importing a DB schema,
 * restarting a server?
 *
 * ANSWER: yes, completely. See the second test. Compiled source suggested otherwise
 * (`toolRequiresApproval = globalRequiresApproval || !!tool.requireApproval`,
 * chunk-3S5BFAEP.js:29097 — an OR, where yolo clears only the run-level half), which
 * is exactly why this was run instead of reasoned about: the controller self-approves
 * the chunk that OR produces.
 *
 * `deploy_resource` is the probe: it declares its own `requireApproval: true`
 * (tools/deploy.ts) and is safe to gate-test because approval is evaluated BEFORE
 * execute, and its execute only pings a server that isn't running.
 *
 * The yolo-off case is the POSITIVE CONTROL. Without it, a silent "no event"
 * in the yolo case is indistinguishable from a broken fixture or a tool that
 * never got registered — the exact mistake that cost this investigation a day.
 */
setupAimock();

const PROMPT = "make the carwash resource live";

function localStore(): MastraCompositeStore {
  return new MastraCompositeStore({
    id: "yolo-approval-test",
    domains: {
      memory: new InMemoryStore().stores.memory,
      workflows: new InMemoryStore().stores.workflows,
    },
  });
}

describe("tool-level requireApproval survives yolo", () => {
  let root: string;
  let harness: ReturnType<typeof createFiveMHarness>;
  let workspace: ReturnType<typeof createFiveMWorkspace>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "yolo-approval-"));
    workspace = createFiveMWorkspace(root);
    await workspace.init();
    harness = createFiveMHarness(workspace, {
      storage: localStore(),
      // Registers deploy_resource (agent.ts). Port 1 is closed, so if approval
      // ever DID fall through, execute just reports "server offline".
      deployConfig: { port: 1, rconPassword: "test-only-not-a-secret" },
    });
    await harness.init();
  }, 60_000);

  afterEach(async () => {
    await harness.destroy().catch(() => {});
    await workspace.destroy().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  /** Run the gated turn under `yolo`, declining if the gate fires. */
  async function run(yolo: boolean): Promise<HarnessWireEvent[]> {
    const events: HarnessWireEvent[] = [];
    let session: Session | null = null;
    let responded = false;
    await runHarnessTurn(harness, {
      text: PROMPT,
      resourceId: "ws_t__srv_t",
      prepareSession: async (s) => {
        await applyFiveMPermissions(s, { requireApproval: true });
        if (yolo) await s.state.set({ yolo: true });
      },
      onSession: (s) => {
        session = s;
      },
      send: (e) => {
        events.push(e);
        if (e.type === "tool_approval_required" && !responded) {
          responded = true;
          queueMicrotask(() => session?.respondToToolApproval({ decision: "decline" }));
        }
      },
    });
    return events;
  }

  it("gates deploy_resource with yolo OFF (positive control)", async () => {
    const events = await run(false);
    expect(events.find((e) => e.type === "tool_approval_required")).toMatchObject({
      toolName: "deploy_resource",
    });
  }, 60_000);

  /**
   * MEASURED 2026-07-29: yolo VOIDS the gate. deploy_resource went
   * tool_start → tool_end with no `tool_approval_required` event and no user
   * decision, even though the tool declares `requireApproval: true`.
   *
   * The compiled OR (`globalRequiresApproval || !!tool.requireApproval`) does still
   * raise an approval chunk — but `Session.resolveToolApproval` returns "allow" for
   * every tool under yolo, so the CONTROLLER consumes that chunk and self-approves
   * instead of surfacing it. Reading the OR alone predicts the opposite; only the
   * run showed it.
   *
   * Consequence: blanket yolo is NOT an acceptable fix for myrp-build-mg6. It would
   * let the agent deploy to a live server, install resources, import a DB schema,
   * or restart a server with no consent. Note `resolveToolApproval` checks per-tool
   * "deny" BEFORE yolo but "ask" AFTER it — so there is no way to keep one tool
   * interactive while yolo is on. It is all-or-nothing.
   *
   * This asserts the CURRENT behaviour deliberately. If it ever starts failing,
   * Mastra changed the interaction and the whole workaround should be re-examined.
   */
  it("yolo VOIDS the gate — deploy_resource runs unapproved", async () => {
    const events = await run(true);
    const types = events.map((e) => e.type);
    expect(
      events.some((e) => e.type === "tool_approval_required"),
      `events: ${JSON.stringify(types)}`,
    ).toBe(false);
    // It didn't merely skip the gate — the tool actually ran.
    expect(types, `events: ${JSON.stringify(types)}`).toContain("tool_end");
  }, 60_000);
});

/**
 * The same question for the tools we DON'T author. execute_command / delete are
 * Mastra Workspace tools gated by a different mechanism — the Workspace's own
 * per-tool config (`tools: { <name>: { requireApproval } }`, workspace.ts), which
 * its docs say "replaces the provider-level requireApproval". If THAT survives
 * yolo, the dangerous-shell surface stays protected for free; if it doesn't, any
 * yolo-based fix has to re-gate host command execution and deletes itself.
 *
 * This is the tool the secure default exists for: a prompt injection reaching
 * execute_command is host code execution.
 */
describe("workspace-level requireApproval under yolo", () => {
  let root: string;
  let victim: string;
  let harness: ReturnType<typeof createFiveMHarness>;
  let workspace: ReturnType<typeof createFiveMWorkspace>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "yolo-ws-approval-"));
    victim = join(root, "[local]", "victim");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "fxmanifest.lua"), "fx_version 'cerulean'\ngame 'gta5'\n");
    // requireApproval: true → the WORKSPACE gates delete, not the session policy.
    workspace = createFiveMWorkspace(root, { requireApproval: true });
    await workspace.init();
    harness = createFiveMHarness(workspace, { storage: localStore() });
    await harness.init();
  }, 60_000);

  afterEach(async () => {
    await harness.destroy().catch(() => {});
    await workspace.destroy().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * Run the gated delete under `yolo`, DECLINING if the gate fires. Deliberately
   * NOT applying applyFiveMPermissions: this must isolate the workspace-level
   * gate from the session-policy gate, or a pass proves nothing about which one
   * held. The file surviving is the ground truth — events can lie, the disk can't.
   */
  async function runDelete(yolo: boolean): Promise<{ gated: boolean; survived: boolean }> {
    let session: Session | null = null;
    let responded = false;
    let gated = false;
    await runHarnessTurn(harness, {
      text: "delete the victim resource",
      resourceId: "ws_t__srv_t",
      prepareSession: async (s) => {
        if (yolo) await s.state.set({ yolo: true });
      },
      onSession: (s) => {
        session = s;
      },
      send: (e) => {
        if (e.type === "tool_approval_required" && !responded) {
          responded = true;
          gated = true;
          queueMicrotask(() => session?.respondToToolApproval({ decision: "decline" }));
        }
      },
    });
    return { gated, survived: existsSync(victim) };
  }

  it("gates the workspace delete with yolo OFF (positive control)", async () => {
    const { gated, survived } = await runDelete(false);
    expect(gated).toBe(true);
    expect(survived, "declined delete must not touch the disk").toBe(true);
  }, 60_000);

  /**
   * MEASURED 2026-07-29: workspace-level `requireApproval` does NOT survive yolo
   * either. No gate fired and the victim directory was REALLY deleted — asserted
   * on disk, not on events. So yolo removes ALL HITL: both the tools we author
   * (deploy/install/import_schema/server-lifecycle, above) and the Mastra
   * Workspace tools we don't (execute_command, kill_process, delete).
   *
   * That sizes any yolo-based fix for myrp-build-mg6: our own tools can re-gate
   * inside `execute`, but execute_command / kill_process / delete have no execute
   * of ours to hook, so they must be wrapped or disabled — they cannot simply be
   * left on. This is the tool the secure default exists for.
   */
  it("yolo VOIDS the workspace gate — the delete really happens", async () => {
    const { gated, survived } = await runDelete(true);
    expect({ gated, survived }).toEqual({ gated: false, survived: false });
  }, 60_000);
});
