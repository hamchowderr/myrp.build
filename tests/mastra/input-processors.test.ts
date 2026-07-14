import type { MastraDBMessage } from "@mastra/core/agent/message-list";
import type { ProcessInputStepArgs } from "@mastra/core/processors";
import { describe, expect, it } from "vitest";
import { DANGEROUS_SHELL_RULES } from "../../src/main/mastra/guardrails";
import { RollingCacheBreakpoint } from "../../src/main/mastra/rolling-cache";

/** True when any dangerous-shell rule fires on `text`. */
function trips(text: string): boolean {
  return DANGEROUS_SHELL_RULES.some((r) => r.pattern.test(text));
}

describe("aku — DANGEROUS_SHELL_RULES", () => {
  it("blocks unambiguously catastrophic commands", () => {
    for (const cmd of [
      "rm -rf /",
      "rm -fr /",
      "rm -rf /*",
      "rm -rf ~",
      "rm -rf .",
      "sudo rm -rf / --no-preserve-root",
      ":(){ :|:& };:",
      "dd if=/dev/zero of=/dev/sda",
      "mkfs.ext4 /dev/sdb",
      "echo x > /dev/sda",
      "format C: /q",
      "del /f /s /q C:\\",
      "rmdir /s /q C:\\Windows",
    ]) {
      expect(trips(cmd), `should block: ${cmd}`).toBe(true);
    }
  });

  it("does NOT trip on ordinary generation prompts", () => {
    for (const prompt of [
      "Build a heal command resource for ox_core",
      "Format the JSON output nicely and remove the temp file",
      "Delete the unused import in client/main.lua",
      "Add an rm-style cleanup helper that removes a player's stash entry",
      "rm -rf build/dist", // scoped subdir, not a catastrophic target
      "Please remove the old ped and re-add it",
    ]) {
      expect(trips(prompt), `should allow: ${prompt}`).toBe(false);
    }
  });
});

describe("5o2.2 — RollingCacheBreakpoint", () => {
  function msg(id: string, text: string): MastraDBMessage {
    return {
      id,
      role: "user",
      content: { format: 2, parts: [{ type: "text", text }] },
    } as unknown as MastraDBMessage;
  }

  async function run(messages: MastraDBMessage[]): Promise<MastraDBMessage[]> {
    const proc = new RollingCacheBreakpoint();
    const out = await proc.processInputStep({ messages } as unknown as ProcessInputStepArgs);
    return (out as MastraDBMessage[] | undefined) ?? messages;
  }

  it("marks ONLY the last message with an ephemeral anthropic cache breakpoint", async () => {
    const out = await run([msg("a", "first"), msg("b", "second"), msg("c", "last")]);
    const cc = (m: MastraDBMessage): unknown =>
      (m.content.providerMetadata as Record<string, Record<string, unknown>> | undefined)?.anthropic
        ?.cacheControl;
    expect(cc(out[2])).toEqual({ type: "ephemeral" });
    expect(cc(out[0])).toBeUndefined();
    expect(cc(out[1])).toBeUndefined();
  });

  it("preserves existing provider metadata on the marked message", async () => {
    const m = msg("a", "only");
    (m.content as { providerMetadata?: unknown }).providerMetadata = {
      openai: { foo: "bar" },
      anthropic: { keep: 1 },
    };
    const [out] = await run([m]);
    const pm = out.content.providerMetadata as Record<string, Record<string, unknown>>;
    expect(pm.openai).toEqual({ foo: "bar" });
    expect(pm.anthropic.keep).toBe(1);
    expect(pm.anthropic.cacheControl).toEqual({ type: "ephemeral" });
  });

  it("no-ops on an empty message list", async () => {
    const proc = new RollingCacheBreakpoint();
    const out = await proc.processInputStep({ messages: [] } as unknown as ProcessInputStepArgs);
    expect(out).toBeUndefined();
  });
});
