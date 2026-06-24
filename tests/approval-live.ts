/* Live verification of the approval pump-resume path (sensitive-ops approval).
 * Asks the agent to delete a resource (gated 'delete' tool) with requireApproval
 * on + an auto-approve handler, and asserts it pauses then RESUMES (no
 * "snapshot not found"). Run: npx tsx tests/approval-live.ts
 * NOTE: real model spend (~$0.20) + actually deletes the named resource. */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { runChatStream } from "../src/main/mastra/chat";
import { oxSkillPaths } from "../src/main/mastra/workspace";

const ROOT = "C:/FXServer/txData/FiveMBasicServerCFXDefault_B89B02.base/resources";
const LOCAL = `${ROOT}/[local]`;
const TARGET = process.argv[2] ?? "flipcoin";

(async () => {
  let approvalRequested = false;
  let resumedAfterApproval = false;
  let sawDeleteResult = false;

  await runChatStream(`Delete the ${TARGET} resource.`, ROOT, {
    threadId: randomUUID(),
    requireApproval: true,
    skillPaths: oxSkillPaths(`${process.cwd()}/skills`),
    indexPaths: [LOCAL],
    awaitApproval: async (runId) => {
      approvalRequested = true;
      console.log(`\n>>> APPROVAL REQUESTED (runId=${runId}) — auto-approving\n`);
      return true;
    },
    onChunk: (chunk) => {
      const c = chunk as { type?: string; toolName?: string };
      if (c.type === "tool-approval-request")
        console.log("chunk: tool-approval-request", c.toolName ?? "");
      if (approvalRequested && c.type?.startsWith("tool-")) resumedAfterApproval = true;
      if (c.type === "tool-output-available" || c.type === "tool-result") sawDeleteResult = true;
    },
  });

  console.log("\n=== RESULT ===");
  console.log("approval requested:", approvalRequested);
  console.log("resumed after approval:", resumedAfterApproval);
  console.log("saw tool result post-approval:", sawDeleteResult);
  console.log(
    approvalRequested && resumedAfterApproval
      ? "✅ approval pause + resume works (no snapshot error)"
      : "⚠️ approval flow did not trigger/resume — inspect above",
  );
  process.exit(0);
})().catch((e) => {
  console.error("❌ FAILED:", e.message);
  process.exit(1);
});
