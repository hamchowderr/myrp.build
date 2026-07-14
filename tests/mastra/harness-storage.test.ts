import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mastra/core/agent";
import { Harness } from "@mastra/core/harness";
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFiveMWorkspace } from "../../src/main/mastra/workspace";

/**
 * De-risk test for the Harness storage phase. Proves the Mastra
 * Harness drives thread lifecycle against a MastraCompositeStore shaped EXACTLY
 * like createSupabaseMemoryStore() — split `memory` + `workflows` domains on one
 * composite store. Here both domains are InMemoryStore so there's no Supabase and
 * no LLM (thread ops are pure storage). The Harness `storage` param is typed
 * `MastraCompositeStore`, so the shape proven here is the same one the live path will pass;
 * the only prod difference is the `memory` domain = SupabaseMemoryStorage.
 */
describe("Harness thread lifecycle over a composite store", () => {
  let root: string;
  let harness: Harness;
  let session: Awaited<ReturnType<Harness["createSession"]>>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "harness-"));
    const workspace = createFiveMWorkspace(root, { interactive: false });
    await workspace.init();
    // Mirror createSupabaseMemoryStore's composition: memory + workflows as
    // separate domains on one MastraCompositeStore (both InMemory in this test).
    const storage = new MastraCompositeStore({
      id: "harness-test-store",
      domains: {
        memory: new InMemoryStore().stores.memory,
        workflows: new InMemoryStore().stores.workflows,
      },
    });
    // Trivial agent — never streamed; the model is not invoked for thread ops.
    const agent = new Agent({
      id: "harness-test-agent",
      name: "harness test",
      instructions: "thread-only; never streamed",
      model: "anthropic/claude-sonnet-4-6",
    });
    harness = new Harness({
      id: "harness-test-harness",
      storage,
      agent,
      workspace,
      modes: [{ id: "generate", name: "Generate" }],
    });
    await harness.init();
    session = await harness.createSession({ resourceId: "ws_test__srv_test" });
  }, 60_000); // workspace + harness init can be slow under cold-start CI load

  afterAll(async () => {
    await harness.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates, lists, renames, clones, switches, and deletes threads", async () => {
    // The session auto-binds a startup thread, so assert against a baseline +
    // membership rather than absolute counts.
    const before = (await session.thread.list()).length;

    const t1 = await session.thread.create({ title: "First" });
    expect(t1.id).toBeTruthy();
    expect(session.thread.getId()).toBe(t1.id);
    let threads = await session.thread.list();
    expect(threads).toHaveLength(before + 1);
    expect(threads.some((t) => t.id === t1.id)).toBe(true);

    await session.thread.rename({ title: "First (renamed)" });
    threads = await session.thread.list();
    expect(threads.find((t) => t.id === t1.id)?.title).toBe("First (renamed)");

    const t2 = await session.thread.clone({ sourceThreadId: t1.id, title: "Clone" });
    expect(t2.id).not.toBe(t1.id);
    threads = await session.thread.list();
    expect(threads).toHaveLength(before + 2);
    expect(threads.some((t) => t.id === t2.id)).toBe(true);

    await session.thread.switch({ threadId: t2.id });
    expect(session.thread.getId()).toBe(t2.id);

    await session.thread.delete({ threadId: t2.id });
    threads = await session.thread.list();
    expect(threads).toHaveLength(before + 1);
    expect(threads.some((t) => t.id === t2.id)).toBe(false);
    expect(threads.some((t) => t.id === t1.id)).toBe(true);
  });
});
