/**
 * Win32 inheritable semaphore creation via Koffi.
 *
 * Creates semaphores with `SECURITY_ATTRIBUTES.bInheritHandle = true`
 * so they can be inherited by child processes launched with CreateProcessW.
 *
 * Used by the FxDK orchestrator to create produce/consume semaphores
 * that are shared between myRP.build and the game client.
 */

import koffi from "koffi";

// ---------------------------------------------------------------------------
// Win32 FFI bindings (lazy-loaded)
// ---------------------------------------------------------------------------

let _kernel32: koffi.IKoffiLib | null = null;

interface SyncApi {
  CreateSemaphoreW: (
    lpSemaphoreAttributes: Buffer,
    lInitialCount: number,
    lMaximumCount: number,
    lpName: string | null,
  ) => unknown;
  CreateMutexW: (
    lpMutexAttributes: Buffer,
    bInitialOwner: number,
    lpName: string | null,
  ) => unknown;
  CloseHandle: (hObject: unknown) => number;
  GetLastError: () => number;
}

let _api: SyncApi | null = null;

function api(): SyncApi {
  if (!_api) {
    if (!_kernel32) {
      _kernel32 = koffi.load("kernel32.dll");
    }
    const k = _kernel32;
    _api = {
      CreateSemaphoreW: k.func("void* __stdcall CreateSemaphoreW(void*, int32_t, int32_t, str16)"),
      CreateMutexW: k.func("void* __stdcall CreateMutexW(void*, int32_t, str16)"),
      CloseHandle: k.func("int32_t __stdcall CloseHandle(void*)"),
      GetLastError: k.func("uint32_t __stdcall GetLastError()"),
    };
  }
  return _api;
}

// ---------------------------------------------------------------------------
// SECURITY_ATTRIBUTES struct layout (manual buffer)
// ---------------------------------------------------------------------------

/**
 * Build a SECURITY_ATTRIBUTES buffer with bInheritHandle = true.
 *
 * Layout (x64):
 *   DWORD  nLength;              // offset 0, 4 bytes
 *   // 4 bytes padding (align LPVOID to 8)
 *   LPVOID lpSecurityDescriptor; // offset 8, 8 bytes
 *   BOOL   bInheritHandle;       // offset 16, 4 bytes
 *   // 4 bytes trailing padding
 *   Total: 24 bytes
 */
function buildInheritableSecurityAttributes(): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32LE(24, 0); // nLength = sizeof(SECURITY_ATTRIBUTES)
  // lpSecurityDescriptor = NULL (offset 8, already zeroed)
  buf.writeInt32LE(1, 16); // bInheritHandle = TRUE
  return buf;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a Win32 semaphore with inheritable handle.
 *
 * @param initialCount - Initial semaphore count.
 *   - For produceSema: set to `surfaceLimit` (game can produce N frames).
 *   - For consumeSema: set to 0 (no frames available yet).
 * @param maxCount - Maximum semaphore count (typically same as surfaceLimit).
 * @param name - Optional name for the semaphore (null for unnamed).
 * @returns Opaque koffi HANDLE pointer. Pass directly to WaitForSingleObject/ReleaseSemaphore.
 * @throws {Error} If CreateSemaphoreW fails.
 */
export function createInheritableSemaphore(
  initialCount: number,
  maxCount: number,
  name?: string,
): unknown {
  const sa = buildInheritableSecurityAttributes();
  const handle = api().CreateSemaphoreW(sa, initialCount, maxCount, name ?? null);

  if (!handle) {
    throw new Error(`CreateSemaphoreW failed (GetLastError=${api().GetLastError()})`);
  }

  return handle;
}

/**
 * Create a Win32 mutex with inheritable handle.
 *
 * Used for the inputMutex in ReverseGameData — the game and SDK host
 * both need to acquire this mutex when reading/writing input state.
 *
 * @param name - Optional name for the mutex (null for unnamed).
 * @returns Opaque koffi HANDLE pointer.
 * @throws {Error} If CreateMutexW fails.
 */
export function createInheritableMutex(name?: string): unknown {
  const sa = buildInheritableSecurityAttributes();
  const handle = api().CreateMutexW(sa, 0, name ?? null);

  if (!handle) {
    throw new Error(`CreateMutexW failed (GetLastError=${api().GetLastError()})`);
  }

  return handle;
}

/**
 * Close a semaphore or mutex handle.
 * Safe to call with null/undefined (no-op).
 */
export function closeSemaphore(handle: unknown): void {
  if (!handle) return;
  api().CloseHandle(handle);
}
