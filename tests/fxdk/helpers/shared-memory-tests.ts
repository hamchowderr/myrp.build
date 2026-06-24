/**
 * FxDK manual-test group: SharedMemory + orchestrator struct roundtrips.
 *
 * Extracted verbatim from tests/fxdk/test-fxdk.ts (behavior-preserving split).
 * Run via the test-fxdk.ts runner: `npx tsx tests/fxdk/test-fxdk.ts`.
 */

import koffi from "koffi";

// ─── Test 1: SharedMemory (cross-process shared memory) ─────────────────────
export async function testSharedMemory() {
  console.log("\n═══ Test 1: SharedMemory ═══");

  const { SharedMemory } = await import("../../../src/main/fxdk/shared-memory");

  // Define a simple struct
  const TestStruct = koffi.struct("TestStruct_SM", {
    counter: "int32",
    value: "float",
    flags: "uint32",
  });

  const shm = new SharedMemory("FiveM_Studio_Test", TestStruct);

  try {
    // 1a: Open creates mapping
    shm.open();
    console.log(`  [PASS] open() — mapping name: ${shm.name}`);
    console.log(`  [INFO] isCreator: ${shm.isCreator}`);

    // 1b: Write struct
    shm.writeStruct({ counter: 42, value: 3.14, flags: 0xff });
    console.log("  [PASS] writeStruct()");

    // 1c: Read struct back
    const data = shm.readStruct();
    const counterOk = data.counter === 42;
    const flagsOk = data.flags === 0xff;
    const valueOk = Math.abs((data.value as number) - 3.14) < 0.01;
    console.log(
      `  [${counterOk ? "PASS" : "FAIL"}] readStruct().counter = ${data.counter} (expected 42)`,
    );
    console.log(
      `  [${valueOk ? "PASS" : "FAIL"}] readStruct().value = ${data.value} (expected ~3.14)`,
    );
    console.log(
      `  [${flagsOk ? "PASS" : "FAIL"}] readStruct().flags = ${data.flags} (expected 255)`,
    );

    // 1d: writeField (read-modify-write)
    shm.writeField("counter", 100);
    const updated = shm.readStruct();
    console.log(
      `  [${updated.counter === 100 ? "PASS" : "FAIL"}] writeField('counter', 100) → ${updated.counter}`,
    );

    // 1e: withLock
    const lockResult = shm.withLock(() => {
      return shm.readStruct().counter;
    });
    console.log(`  [${lockResult === 100 ? "PASS" : "FAIL"}] withLock() → ${lockResult}`);

    // 1f: Raw byte access
    const raw = shm.read(0, 4); // first 4 bytes = counter as int32
    const rawValue = raw.readInt32LE(0);
    console.log(`  [${rawValue === 100 ? "PASS" : "FAIL"}] read(0, 4) raw bytes → ${rawValue}`);
  } catch (err) {
    console.log(`  [FAIL] SharedMemory error: ${err}`);
  } finally {
    shm.close();
    console.log("  [PASS] close()");
  }
}

// ─── Test 6: Orchestrator structs (shared memory roundtrip) ──────────────────
export async function testOrchestratorStructs() {
  console.log("\n═══ Test 6: Orchestrator structs (shared memory roundtrip) ═══");

  const { SharedMemory } = await import("../../../src/main/fxdk/shared-memory");
  // The "CfxInitState" shared block is typed as the CfxState struct (see
  // fxdk-orchestrator.ts: new SharedMemory("CfxInitState", CfxState)). structs.ts
  // exports the struct as CfxState — there is no CfxInitState export.
  const { CfxState, ReverseGameData, getStructSizes, RGD_OFFSETS, PTR_SIZE } = await import(
    "../../../src/main/fxdk/structs"
  );

  try {
    // 6a: Check struct sizes are sane
    const sizes = getStructSizes();
    console.log(`  [INFO] CfxState size: ${sizes.CfxState} bytes`);
    console.log(`  [INFO] ReverseGameData size: ${sizes.ReverseGameData} bytes`);

    const initSizeOk = sizes.CfxState === 12376;
    console.log(
      `  [${initSizeOk ? "PASS" : "WARN"}] CfxState size = ${sizes.CfxState} (expected 12376)`,
    );

    // RGD should be at least 400 bytes (keyboard alone is 256)
    const rgdSizeOk = sizes.ReverseGameData >= 400;
    console.log(
      `  [${rgdSizeOk ? "PASS" : "WARN"}] ReverseGameData size = ${sizes.ReverseGameData} (expected ≥400)`,
    );

    // 6b: CfxInitState block (CfxState struct) — write and read back
    const initShm = new SharedMemory("FiveM_Studio_Test_Init", CfxState);
    initShm.open();

    initShm.writeStruct({
      isReverseGame: true,
      _pad0: [0, 0, 0],
      gamePid: 12345,
    });

    const initData = initShm.readStruct();
    const reverseOk = initData.isReverseGame === true;
    const pidOk = initData.gamePid === 12345;
    console.log(
      `  [${reverseOk ? "PASS" : "FAIL"}] CfxInitState.isReverseGame = ${initData.isReverseGame}`,
    );
    console.log(
      `  [${pidOk ? "PASS" : "FAIL"}] CfxInitState.gamePid = ${initData.gamePid} (expected 12345)`,
    );
    initShm.close();

    // 6c: ReverseGameData — raw byte access for critical fields
    const rgdShm = new SharedMemory("FiveM_Studio_Test_RGD", ReverseGameData);
    rgdShm.open();

    // Write width via raw bytes
    const widthBuf = Buffer.alloc(4);
    widthBuf.writeInt32LE(1920);
    rgdShm.write(RGD_OFFSETS.width, widthBuf);

    // Write height
    const heightBuf = Buffer.alloc(4);
    heightBuf.writeInt32LE(1080);
    rgdShm.write(RGD_OFFSETS.height, heightBuf);

    // Write inited = true
    const initedBuf = Buffer.alloc(1);
    initedBuf.writeUInt8(1);
    rgdShm.write(RGD_OFFSETS.inited, initedBuf);

    // Write surfaceLimit
    const slBuf = Buffer.alloc(4);
    slBuf.writeInt32LE(4);
    rgdShm.write(RGD_OFFSETS.surfaceLimit, slBuf);

    // Read back via raw bytes
    const readWidth = rgdShm.read(RGD_OFFSETS.width, 4).readInt32LE(0);
    const readHeight = rgdShm.read(RGD_OFFSETS.height, 4).readInt32LE(0);
    const readInited = rgdShm.read(RGD_OFFSETS.inited, 1)[0];
    const readSurfLimit = rgdShm.read(RGD_OFFSETS.surfaceLimit, 4).readInt32LE(0);

    console.log(
      `  [${readWidth === 1920 ? "PASS" : "FAIL"}] RGD raw width = ${readWidth} (expected 1920)`,
    );
    console.log(
      `  [${readHeight === 1080 ? "PASS" : "FAIL"}] RGD raw height = ${readHeight} (expected 1080)`,
    );
    console.log(
      `  [${readInited === 1 ? "PASS" : "FAIL"}] RGD raw inited = ${readInited} (expected 1)`,
    );
    console.log(
      `  [${readSurfLimit === 4 ? "PASS" : "FAIL"}] RGD raw surfaceLimit = ${readSurfLimit} (expected 4)`,
    );

    // 6d: Verify surface handle offset is after consumeSema
    const surfOffset = RGD_OFFSETS.surfaces;
    const semaOffset = RGD_OFFSETS.consumeSema;
    console.log(
      `  [${surfOffset > semaOffset ? "PASS" : "FAIL"}] surfaces offset (${surfOffset}) > consumeSema offset (${semaOffset})`,
    );
    console.log(
      `  [INFO] Surface stride: ${PTR_SIZE} bytes per handle, ${4 * PTR_SIZE} bytes total`,
    );

    rgdShm.close();
  } catch (err) {
    console.log(`  [FAIL] Orchestrator structs error: ${err}`);
  }
}
