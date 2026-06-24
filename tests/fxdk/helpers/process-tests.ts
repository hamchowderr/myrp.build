/**
 * FxDK manual-test group: ProcessManager + Semaphore + orchestrator state machine.
 *
 * Extracted verbatim from tests/fxdk/test-fxdk.ts (behavior-preserving split).
 * Run via the test-fxdk.ts runner: `npx tsx tests/fxdk/test-fxdk.ts`.
 */

import koffi from "koffi";

// ─── Test 4: ProcessManager (spawn/suspend/resume/terminate) ─────────────────
// Uses cmd.exe (true Win32 process) instead of notepad.exe (UWP wrapper on Win11)
export async function testProcessManager() {
  console.log("\n═══ Test 4: ProcessManager (spawn/suspend/resume/terminate) ═══");

  const { FiveMProcessManager } = await import("../../../src/main/fxdk/process-manager");

  const pm = new FiveMProcessManager();

  try {
    // 4a: Launch cmd.exe suspended (timeout keeps it alive)
    const handle = pm.launch(
      "C:\\Windows\\System32\\cmd.exe",
      ["/c", "timeout", "/t", "60", "/nobreak"],
      { suspended: true },
    );
    console.log(`  [PASS] launch(cmd.exe, suspended) → PID ${handle.pid}, TID ${handle.tid}`);
    console.log(
      `  [DEBUG] hProcess type=${typeof handle.hProcess}, hThread type=${typeof handle.hThread}`,
    );

    // 4b: isRunning should be true (suspended counts as running)
    console.log(`  [${pm.isRunning(handle) ? "PASS" : "FAIL"}] isRunning() = true (suspended)`);

    // 4c: Resume
    const prevCount = pm.resume(handle);
    console.log(`  [PASS] resume() → previous suspend count: ${prevCount}`);

    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 500));
    const stillRunning = pm.isRunning(handle);
    if (stillRunning) {
      console.log("  [PASS] isRunning() = true (running)");
      // 4d: Terminate
      pm.terminate(handle);
      await new Promise((r) => setTimeout(r, 200));
      console.log(
        `  [${!pm.isRunning(handle) ? "PASS" : "FAIL"}] terminate() → isRunning() = false`,
      );
    } else {
      // cmd.exe with CREATE_NO_WINDOW and timeout may exit immediately
      console.log(
        "  [INFO] isRunning() = false (process already exited — expected for cmd.exe /c timeout with no console)",
      );
      console.log("  [PASS] process lifecycle complete (launch→suspend→resume→exit)");
    }

    // 4e: Close handles
    pm.close(handle);
    console.log("  [PASS] close()");
  } catch (err) {
    console.log(`  [FAIL] ProcessManager error: ${err}`);
  } finally {
    pm.dispose();
  }
}

// ─── Test 7: Semaphore creation and signalling ───────────────────────────────
export async function testSemaphoreCreation() {
  console.log("\n═══ Test 7: Semaphore creation and signalling ═══");

  const { createInheritableSemaphore, closeSemaphore } = await import(
    "../../../src/main/fxdk/semaphore"
  );

  // Load kernel32 for WaitForSingleObject / ReleaseSemaphore
  const kernel32 = koffi.load("kernel32.dll");
  const WaitForSingleObject = kernel32.func(
    "uint32_t __stdcall WaitForSingleObject(void*, uint32_t)",
  );
  const ReleaseSemaphore = kernel32.func(
    "int32_t __stdcall ReleaseSemaphore(void*, int32_t, void*)",
  );

  const WAIT_OBJECT_0 = 0x00000000;
  const WAIT_TIMEOUT = 0x00000102;

  try {
    // 7a: Create produce semaphore (initial=4, max=4)
    const produceSema = createInheritableSemaphore(4, 4);
    console.log(`  [PASS] createInheritableSemaphore(4, 4) — produce sema`);

    // 7b: Create consume semaphore (initial=0, max=4)
    const consumeSema = createInheritableSemaphore(0, 4);
    console.log(`  [PASS] createInheritableSemaphore(0, 4) — consume sema`);

    // 7c: Wait on produce — should succeed immediately (count=4)
    const waitProduce = WaitForSingleObject(produceSema, 0);
    console.log(
      `  [${waitProduce === WAIT_OBJECT_0 ? "PASS" : "FAIL"}] WaitForSingleObject(produce, 0) = ${waitProduce} (expected 0)`,
    );

    // 7d: Wait on consume — should timeout (count=0)
    const waitConsume = WaitForSingleObject(consumeSema, 0);
    console.log(
      `  [${waitConsume === WAIT_TIMEOUT ? "PASS" : "FAIL"}] WaitForSingleObject(consume, 0) = 0x${waitConsume.toString(16)} (expected WAIT_TIMEOUT)`,
    );

    // 7e: Signal consume, then wait — should succeed
    const released = ReleaseSemaphore(consumeSema, 1, null);
    console.log(`  [${released ? "PASS" : "FAIL"}] ReleaseSemaphore(consume, 1) = ${released}`);

    const waitAgain = WaitForSingleObject(consumeSema, 0);
    console.log(
      `  [${waitAgain === WAIT_OBJECT_0 ? "PASS" : "FAIL"}] WaitForSingleObject(consume) after signal = ${waitAgain} (expected 0)`,
    );

    // 7f: Clean up
    closeSemaphore(produceSema);
    closeSemaphore(consumeSema);
    console.log("  [PASS] closeSemaphore() — both handles closed");
  } catch (err) {
    console.log(`  [FAIL] Semaphore error: ${err}`);
  }
}

// ─── Test 8: Orchestrator state machine (timeout test) ───────────────────────
export async function testStateMachineTimeout() {
  console.log("\n═══ Test 8: Orchestrator state machine (timeout) ═══");

  const { FxDkOrchestrator } = await import("../../../src/main/fxdk/fxdk-orchestrator");

  const orch = new FxDkOrchestrator();
  const stateLog: string[] = [];

  orch.on("stateChange", (state) => {
    stateLog.push(state);
  });

  try {
    // 8a: Initial state should be idle
    console.log(
      `  [${orch.state === "idle" ? "PASS" : "FAIL"}] Initial state = "${orch.state}" (expected "idle")`,
    );

    // 8b: Start with cmd.exe as mock game (it won't set RGD.inited, so we'll timeout)
    // Use a very short timeout (2s) to keep the test fast
    console.log("  [INFO] Starting with cmd.exe as mock game (2s timeout)...");
    const result = await orch.startGame({
      fivemExePath: "C:\\Windows\\System32\\cmd.exe",
      serverAddress: "localhost:30120",
      width: 640,
      height: 480,
      initTimeoutMs: 2000,
    });

    // 8c: Should fail with timeout
    console.log(`  [${!result.ok ? "PASS" : "FAIL"}] startGame() returned ok=${result.ok}`);
    if (result.error) {
      const hasTimeout =
        result.error.includes("2000ms") ||
        result.error.includes("timed out") ||
        result.error.includes("exited");
      console.log(`  [${hasTimeout ? "PASS" : "INFO"}] Error: "${result.error}"`);
    }

    // 8d: State should be "error" after timeout
    console.log(
      `  [${orch.state === "error" ? "PASS" : "FAIL"}] State after timeout = "${orch.state}" (expected "error")`,
    );

    // 8e: State log should show progression
    console.log(`  [INFO] State transitions: ${stateLog.join(" → ")}`);
    const hasInit = stateLog.includes("initializing");
    const hasLaunch = stateLog.includes("launching");
    console.log(`  [${hasInit ? "PASS" : "FAIL"}] Passed through "initializing"`);
    console.log(`  [${hasLaunch ? "PASS" : "FAIL"}] Passed through "launching"`);

    // 8f: Resources should be cleaned up — getSurfaceHandles should return null
    console.log(
      `  [${orch.getSurfaceHandles() === null ? "PASS" : "FAIL"}] getSurfaceHandles() = null (cleaned up)`,
    );
    console.log(
      `  [${orch.getSemaphoreHandles() === null ? "PASS" : "FAIL"}] getSemaphoreHandles() = null (cleaned up)`,
    );

    // 8g: Can restart from error state
    console.log("  [INFO] Testing restart from error state...");
    const result2 = await orch.startGame({
      fivemExePath: "C:\\Windows\\System32\\cmd.exe",
      initTimeoutMs: 1000,
    });
    console.log(
      `  [${!result2.ok ? "PASS" : "INFO"}] Second startGame() from error state completed (ok=${result2.ok})`,
    );
  } catch (err) {
    console.log(`  [FAIL] Orchestrator state machine error: ${err}`);
  } finally {
    orch.destroy();
    console.log("  [PASS] destroy() — orchestrator cleaned up");
  }
}
