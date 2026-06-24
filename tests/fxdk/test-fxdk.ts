/**
 * Manual test script for FxDK modules.
 * Run: npx tsx tests/fxdk/test-fxdk.ts
 *
 * Tests are grouped by tier. Each test prints PASS/FAIL.
 * No FiveM server or game client needed — these test the primitives in isolation.
 *
 * The individual test groups live under ./helpers/ (split to stay under the
 * 500-line cap, fivem-studio-h4x); this file is the runner that sequences them.
 */

import { testGameView } from "./helpers/gameview-tests";
import { testFxServerIpc, testLauncherTalk } from "./helpers/ipc-tests";
import {
  testProcessManager,
  testSemaphoreCreation,
  testStateMachineTimeout,
} from "./helpers/process-tests";
import { testOrchestratorStructs, testSharedMemory } from "./helpers/shared-memory-tests";

// ─── Run all tests ──────────────────────────────────────────────────────────
async function main() {
  console.log("FxDK Integration — Manual Test Suite");
  console.log("════════════════════════════════════════");

  await testSharedMemory();
  await testFxServerIpc();
  await testLauncherTalk();
  await testProcessManager();
  await testGameView();
  await testOrchestratorStructs();
  await testSemaphoreCreation();
  await testStateMachineTimeout();

  console.log("\n════════════════════════════════════════");
  console.log("Done. Review PASS/FAIL above.");
}

main().catch(console.error);
