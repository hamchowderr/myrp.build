/**
 * Koffi struct definitions matching FxDK's C++ shared memory layouts.
 *
 * Two structs are defined:
 * - CfxState — full CfxState from CfxState.h (used as HostSharedData<CfxState>("CfxInitState"))
 * - ReverseGameData — full game↔SDK data channel (input, semaphores, surfaces)
 *
 * These must match the C++ `sizeof` exactly for cross-process shared memory
 * to work. If alignment drifts, use the raw byte offset fallback (RGD_OFFSETS / CFXSTATE_OFFSETS).
 */

import koffi from "koffi";

// ---------------------------------------------------------------------------
// CfxState — full layout from CfxState.h
// ---------------------------------------------------------------------------

/**
 * Matches FxDK's CfxState struct exactly. Used as HostSharedData<CfxState>("CfxInitState").
 *
 * C++ layout:
 *   int initialLauncherPid;       // offset 0
 *   int initialGamePid;           // offset 4
 *   int gamePid;                  // offset 8
 *   int gameBuild;                // offset 12
 *   bool inJobObject;             // offset 16
 *   bool running;                 // offset 17
 *   bool ranPastInstaller;        // offset 18
 *   bool isReverseGame;           // offset 19
 *   wchar_t initPathGame[1024];   // offset 20, 2048 bytes
 *   wchar_t initPathLauncher[1024]; // offset 2068, 2048 bytes
 *   wchar_t gameDirectory[1024];  // offset 4116, 2048 bytes
 *   wchar_t gameExePath[1024];    // offset 6164, 2048 bytes
 *   wchar_t initCommandLine[2048]; // offset 8212, 4096 bytes
 *   wchar_t linkProtocol[32];     // offset 12308, 64 bytes
 *   ProductID productId;          // offset 12372, 4 bytes (enum = int)
 *   Total: 12376 bytes
 */
export const CfxState = koffi.struct("CfxState", {
  initialLauncherPid: "int32",
  initialGamePid: "int32",
  gamePid: "int32",
  gameBuild: "int32",
  inJobObject: "bool",
  running: "bool",
  ranPastInstaller: "bool",
  isReverseGame: "bool",
  initPathGame: koffi.array("uint16", 1024), // wchar_t[1024]
  initPathLauncher: koffi.array("uint16", 1024),
  gameDirectory: koffi.array("uint16", 1024),
  gameExePath: koffi.array("uint16", 1024),
  initCommandLine: koffi.array("uint16", 2048),
  linkProtocol: koffi.array("uint16", 32),
  productId: "int32",
});

/**
 * Raw byte offsets for CfxState fields.
 * Use with SharedMemory.read(offset, length) / SharedMemory.write(offset, buf).
 */
export const CFXSTATE_OFFSETS = {
  initialLauncherPid: 0,
  initialGamePid: 4,
  gamePid: 8,
  gameBuild: 12,
  inJobObject: 16,
  running: 17,
  ranPastInstaller: 18,
  isReverseGame: 19,
  initPathGame: 20, // wchar_t[1024] = 2048 bytes
  initPathLauncher: 2068, // 20 + 2048
  gameDirectory: 4116, // 2068 + 2048
  gameExePath: 6164, // 4116 + 2048
  initCommandLine: 8212, // 6164 + 2048
  linkProtocol: 12308, // 8212 + 4096
  productId: 12372, // 12308 + 64
} as const;

/** Expected sizeof(CfxState) = 12376 bytes. */
export const CFXSTATE_SIZE = 12376;

// ---------------------------------------------------------------------------
// ReverseGameData — full layout from ReverseGameData.h
// ---------------------------------------------------------------------------

/**
 * Matches FxDK's `ReverseGameData` struct used for the game↔SDK render channel.
 *
 * Critical fields:
 * - produceSema / consumeSema: semaphore HANDLEs for ring buffer sync
 * - surfaces[4]: DXGI shared texture HANDLEs
 * - inited: set to true by the game when render surfaces are ready
 * - width/height: actual render dimensions
 *
 * All `void *` fields are 8 bytes on x64 (HANDLE / HWND).
 * Explicit padding fields ensure correct alignment.
 */
export const ReverseGameData = koffi.struct("ReverseGameData", {
  // Keyboard + mouse input block
  keyboardState: koffi.array("uint8", 256), // 256 bytes
  mouseAbsX: "int32", // +256
  mouseAbsY: "int32", // +260
  mouseDeltaX: "int32", // +264
  mouseDeltaY: "int32", // +268
  mouseWheel: "int32", // +272
  mouseButtons: "int32", // +276
  useRawMouseCapture: "bool", // +280
  skipKeyboardStateCopyback: "bool", // +281
  _pad1: koffi.array("uint8", 6), // +282, align to 8 for HANDLE at +288

  // Synchronization handles — use uint64 instead of void* to avoid
  // koffi pointer semantics on raw shared memory (segfault with null ptrs)
  inputMutex: "uint64", // +288, HANDLE (8 bytes on x64)
  inputMutexPID: "uint32", // +296
  _pad2: koffi.array("uint8", 4), // +300, align to 8 for next HANDLE

  // Ring buffer semaphores
  produceSema: "uint64", // +304, HANDLE
  consumeSema: "uint64", // +312, HANDLE

  // Surface ring buffer (DXGI shared handles)
  surfaces: koffi.array("uint64", 4), // +320, HANDLE[4] = 32 bytes
  surfaceLimit: "int32", // +352
  produceIdx: "uint32", // +356
  consumeIdx: "uint32", // +360

  // Dimensions
  width: "int32", // +364
  height: "int32", // +368
  twidth: "int32", // +372
  theight: "int32", // +376

  // State flags
  inited: "bool", // +380
  isLauncher: "bool", // +381
  createHandles: "bool", // +382
  editWidth: "bool", // +383

  // +384 is 8-byte aligned, no padding needed for HWND
  mainWindowHandle: "uint64", // +384, HWND

  // Misc
  fpsLimit: "uint32", // +392
  inputChar: "uint16", // +396
  _pad3: koffi.array("uint8", 2), // +398, align for gamepad

  // Gamepad state
  gamepad: koffi.array("uint8", 96), // +400
});

// ---------------------------------------------------------------------------
// Raw byte offsets — fallback if struct alignment doesn't match C++
// ---------------------------------------------------------------------------

/**
 * Known byte offsets for critical ReverseGameData fields.
 * Use these with SharedMemory.read(offset, length) if koffi.sizeof(ReverseGameData)
 * doesn't match the C++ sizeof.
 */
export const RGD_OFFSETS = {
  keyboardState: 0,
  mouseAbsX: 256,
  mouseAbsY: 260,
  mouseButtons: 276,
  useRawMouseCapture: 280,
  inputMutex: 288,
  inputMutexPID: 296,
  produceSema: 304,
  consumeSema: 312,
  surfaces: 320, // 4 × 8 = 32 bytes
  surfaceLimit: 352,
  produceIdx: 356,
  consumeIdx: 360,
  width: 364,
  height: 368,
  twidth: 372,
  theight: 376,
  inited: 380,
  isLauncher: 381,
  createHandles: 382,
  mainWindowHandle: 384,
  fpsLimit: 392,
  inputChar: 396,
  gamepad: 400,
} as const;

/** Size of a single void* on x64 (HANDLE, HWND). */
export const PTR_SIZE = 8;

/** Number of surface slots in the ring buffer. */
export const MAX_SURFACES = 4;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Returns the koffi-computed sizes of both structs.
 * Compare against C++ sizeof to verify alignment.
 */
export function getStructSizes(): {
  CfxState: number;
  ReverseGameData: number;
} {
  return {
    CfxState: koffi.sizeof(CfxState),
    ReverseGameData: koffi.sizeof(ReverseGameData),
  };
}
