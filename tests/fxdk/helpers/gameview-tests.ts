/**
 * FxDK manual-test group: GameView capability detection.
 *
 * Extracted verbatim from tests/fxdk/test-fxdk.ts (behavior-preserving split).
 * Run via the test-fxdk.ts runner: `npx tsx tests/fxdk/test-fxdk.ts`.
 */

// ─── Test 5: GameView capability detection ──────────────────────────────────
export async function testGameView() {
  console.log("\n═══ Test 5: GameView (capability detection) ═══");

  const { GameView } = await import("../../../src/main/fxdk/game-view");

  try {
    // 5a: Detect capabilities
    const caps = GameView.detectCapabilities();
    console.log(`  [INFO] GPU available: ${caps.gpuAvailable}`);
    console.log(`  [INFO] CPU available: ${caps.cpuAvailable}`);
    console.log(`  [INFO] Reason: ${caps.reason}`);

    // GPU should be false (Electron v39 doesn't support sharedTexture)
    console.log(
      `  [${!caps.gpuAvailable ? "PASS" : "INFO"}] gpuAvailable = false (expected — Electron v39)`,
    );

    // CPU depends on whether D3D11 is available
    if (caps.cpuAvailable) {
      console.log("  [PASS] cpuAvailable = true (D3D11 device created successfully)");
    } else {
      console.log(
        "  [INFO] cpuAvailable = false (no D3D11 device — expected on CPU-only or remote)",
      );
    }

    // 5b: Create a GameView instance
    const gv = new GameView({ width: 1280, height: 720, preferGpu: false });
    console.log(`  [PASS] new GameView(1280x720, preferGpu=false)`);
    console.log(
      `  [${gv.getBackend() === "none" ? "PASS" : "FAIL"}] backend = "none" before start()`,
    );

    // 5c: Stats before start
    const stats = gv.getStats();
    console.log(
      `  [${stats.fps === 0 ? "PASS" : "FAIL"}] getStats().fps = ${stats.fps} (expected 0)`,
    );

    // 5d: Start with dummy handles (will use CPU path if D3D11 available, but no actual frames)
    gv.start([0n, 0n], 2);
    console.log(`  [INFO] start() → backend: ${gv.getBackend()}`);

    // 5e: Stop
    gv.stop();
    console.log(`  [${gv.getBackend() === "none" ? "PASS" : "FAIL"}] stop() → backend = "none"`);
  } catch (err) {
    console.log(`  [FAIL] GameView error: ${err}`);
  }
}
