/**
 * Construct smoke: prove the FiveM supervisor agent builds on a Workspace
 * and exposes it, WITHOUT calling stream()/generate() — no model resolution, no
 * Anthropic tokens spent. Validates the structure only.
 *
 *   npx tsx tests/mastra/smoke-agent.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFiveMAgent } from "../../src/main/mastra/agent";
import { createFiveMWorkspace } from "../../src/main/mastra/workspace";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "fivem-agent-"));
  mkdirSync(join(root, "[local]"), { recursive: true });
  writeFileSync(join(root, "[local]", ".keep"), "");

  const ws = createFiveMWorkspace(root);
  await ws.init();

  const agent = createFiveMAgent(ws);
  console.log("[smoke] agent constructed:", agent.name, "/ id:", agent.id);

  const boundWs = await agent.getWorkspace();
  if (!boundWs) throw new Error("agent has no workspace");
  console.log("[smoke] getWorkspace() ok, same instance:", boundWs === ws);

  const subAgents = await agent.listAgents();
  console.log(
    "[smoke] listAgents() ok, count:",
    Object.keys(subAgents ?? {}).length,
    "(expected 0 for now)",
  );

  await ws.destroy();
  rmSync(root, { recursive: true, force: true });
  console.log("[smoke] PASS — supervisor agent builds on the workspace");
}

main().catch((err) => {
  console.error("[smoke] FAIL:", err);
  process.exit(1);
});
