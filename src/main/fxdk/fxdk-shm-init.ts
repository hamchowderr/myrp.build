/**
 * FxDK shared-memory field initialization.
 *
 * Behavior-preserving extraction of the CfxState + ReverseGameData buffer-write
 * sequences from FxDkOrchestrator.startGame. The orchestrator still owns the
 * SharedMemory / mutex / semaphore lifecycle (it needs them for cleanup); these
 * helpers only perform the exact same ordered writes into the already-opened
 * shared-memory regions.
 */

import koffi from "koffi";
import type { SharedMemory } from "./shared-memory";
import { CFXSTATE_OFFSETS, PTR_SIZE, RGD_OFFSETS } from "./structs";

/**
 * Write gamePid + initialGamePid into CfxState after the game process launches.
 * Mirrors the original post-launch CfxState write in startGame exactly.
 */
export function writeGamePid(shm: SharedMemory, pid: number): void {
  const gamePidBuf = Buffer.alloc(4);
  gamePidBuf.writeInt32LE(pid);
  shm.write(CFXSTATE_OFFSETS.gamePid, gamePidBuf);
  shm.write(CFXSTATE_OFFSETS.initialGamePid, gamePidBuf);
}

/**
 * Read the game's render dimensions + surface handles out of ReverseGameData
 * once it reports inited. Pure read of the already-opened shared memory;
 * mirrors the original surface-read block in waitForGameInit exactly.
 */
export function readGameSurfaces(
  shm: SharedMemory,
  surfaceLimit: number,
): { width: number; height: number; handles: unknown[] } {
  // Read dimensions
  const widthBuf = shm.read(RGD_OFFSETS.width, 4);
  const heightBuf = shm.read(RGD_OFFSETS.height, 4);
  const width = widthBuf.readInt32LE(0);
  const height = heightBuf.readInt32LE(0);

  // Read surface handles (opaque void* pointers)
  const handles: unknown[] = [];
  for (let i = 0; i < surfaceLimit; i++) {
    const offset = RGD_OFFSETS.surfaces + i * PTR_SIZE;
    const handleBuf = shm.read(offset, PTR_SIZE);
    const handle = koffi.decode(handleBuf, "void *");
    handles.push(handle);
  }

  return { width, height, handles };
}

/**
 * Write an opaque koffi pointer (HANDLE) into shared memory at the given offset.
 * Uses koffi.address() to extract the numeric address, then writes as uint64LE.
 */
export function writeHandleToShm(shm: SharedMemory, offset: number, handle: unknown): void {
  const buf = Buffer.alloc(PTR_SIZE);
  const addr = koffi.address(handle);
  buf.writeBigUInt64LE(addr);
  shm.write(offset, buf);
}

export interface CfxStateInit {
  /** FiveM.app directory (used to fill initPathGame). */
  fivemAppDir: string;
  /** Game build number resolved from CitizenFX.ini. */
  gameBuild: number;
}

/**
 * Write the required CfxState fields (reverse/SDK mode) at their correct offsets.
 * Mirrors the original startGame Phase-1 CfxState write sequence exactly.
 */
export function writeCfxState(
  shm: SharedMemory,
  init: CfxStateInit,
  log: (level: "info" | "warn" | "error", message: string) => void,
): void {
  const int32Buf = Buffer.alloc(4);

  // initialLauncherPid = our PID
  int32Buf.writeInt32LE(process.pid);
  shm.write(CFXSTATE_OFFSETS.initialLauncherPid, int32Buf);

  // running = true
  const trueByte = Buffer.alloc(1);
  trueByte.writeUInt8(1);
  shm.write(CFXSTATE_OFFSETS.running, trueByte);

  // isReverseGame = true (offset 19, NOT offset 0!)
  shm.write(CFXSTATE_OFFSETS.isReverseGame, trueByte);

  // Pre-fill initPathGame with FiveM.app directory so the game can find
  // citizen/, CoreRT.dll, etc. Without this, the game auto-fills from
  // GetModuleFileName (subprocess cache dir) and can't resolve paths.
  const initPathBuf = Buffer.alloc(1024 * 2); // wchar_t[1024]
  // Write path as UTF-16LE with trailing backslash
  const pathWithSlash = init.fivemAppDir.endsWith("\\")
    ? init.fivemAppDir
    : `${init.fivemAppDir}\\`;
  initPathBuf.write(pathWithSlash, 0, "utf16le");
  shm.write(CFXSTATE_OFFSETS.initPathGame, initPathBuf);
  log("info", `initPathGame set to: ${pathWithSlash}`);

  // gameBuild — read from CitizenFX.ini. The game asserts gameBuild != -1
  // in xbr::GetGameBuild(), so this MUST be set before launch.
  const gameBuildBuf = Buffer.alloc(4);
  gameBuildBuf.writeInt32LE(init.gameBuild);
  shm.write(CFXSTATE_OFFSETS.gameBuild, gameBuildBuf);
  log("info", `gameBuild set to: ${init.gameBuild}`);

  // productId — the game asserts productId != INVALID (0).
  // ProductID::FIVEM = 1 (from CfxState.h enum)
  const productIdBuf = Buffer.alloc(4);
  productIdBuf.writeInt32LE(1); // ProductID::FIVEM
  shm.write(CFXSTATE_OFFSETS.productId, productIdBuf);
  log("info", "productId set to: 1 (FIVEM)");

  log("info", "CfxState shared memory opened (isReverseGame=true)");
}

export interface ReverseGameDataInit {
  /** Inheritable input mutex HANDLE. */
  inputMutex: unknown;
  /** Inheritable consume semaphore HANDLE. */
  consumeSema: unknown;
  /** Inheritable produce semaphore HANDLE. */
  produceSema: unknown;
  /** Render width. */
  width: number;
  /** Render height. */
  height: number;
  /** Target FPS limit. */
  fpsLimit: number;
  /** Number of surface slots in the ring buffer. */
  surfaceLimit: number;
}

/**
 * Write the ReverseGameData fields (handles, dimensions, config) into the
 * already-opened shared memory. Mirrors the original startGame Phase-1
 * ReverseGameData write sequence exactly.
 */
export function writeReverseGameData(
  shm: SharedMemory,
  init: ReverseGameDataInit,
  log: (level: "info" | "warn" | "error", message: string) => void,
): void {
  // Write handles into ReverseGameData shared memory
  writeHandleToShm(shm, RGD_OFFSETS.inputMutex, init.inputMutex);
  writeHandleToShm(shm, RGD_OFFSETS.consumeSema, init.consumeSema);
  writeHandleToShm(shm, RGD_OFFSETS.produceSema, init.produceSema);

  // Set inputMutexPID = our PID (SDKMain.cpp sets this)
  const pidBuf = Buffer.alloc(4);
  pidBuf.writeUInt32LE(process.pid);
  shm.write(RGD_OFFSETS.inputMutexPID, pidBuf);

  // Set isLauncher=true (FxDK SDKRender.cpp sets this)
  const trueBuf2 = Buffer.alloc(1);
  trueBuf2.writeUInt8(1);
  shm.write(RGD_OFFSETS.isLauncher, trueBuf2);

  // Write dimensions and config
  const dimBuf = Buffer.alloc(4);
  dimBuf.writeInt32LE(init.width);
  shm.write(RGD_OFFSETS.width, dimBuf);
  dimBuf.writeInt32LE(init.height);
  shm.write(RGD_OFFSETS.height, dimBuf);
  dimBuf.writeInt32LE(init.width);
  shm.write(RGD_OFFSETS.twidth, dimBuf);
  dimBuf.writeInt32LE(init.height);
  shm.write(RGD_OFFSETS.theight, dimBuf);

  const fpsLimitBuf = Buffer.alloc(4);
  fpsLimitBuf.writeUInt32LE(init.fpsLimit);
  shm.write(RGD_OFFSETS.fpsLimit, fpsLimitBuf);

  const surfLimitBuf = Buffer.alloc(4);
  surfLimitBuf.writeInt32LE(init.surfaceLimit);
  shm.write(RGD_OFFSETS.surfaceLimit, surfLimitBuf);

  // Set createHandles = true so the game creates DXGI shared handles
  const trueBuf = Buffer.alloc(1);
  trueBuf.writeUInt8(1);
  shm.write(RGD_OFFSETS.createHandles, trueBuf);

  // Set produceIdx=1 (FxDK SDKRender.cpp sets this)
  const prodIdxBuf = Buffer.alloc(4);
  prodIdxBuf.writeUInt32LE(1);
  shm.write(RGD_OFFSETS.produceIdx, prodIdxBuf);

  log("info", "ReverseGameData shared memory initialized");
}
