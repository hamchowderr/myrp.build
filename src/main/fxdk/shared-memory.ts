/**
 * Windows Shared Memory via Koffi — replicates FxDK's HostSharedData pattern.
 *
 * Cross-process shared memory using Win32 named file mappings. The naming
 * convention matches FxDK exactly: `CFX_{launchMode}_{productKey}_SharedData_{name}`
 *
 * @example
 * ```ts
 * import koffi from 'koffi'
 * import { SharedMemory } from './shared-memory'
 *
 * const layout = koffi.struct('GameState', {
 *   state: 'int32',
 *   progress: 'float',
 *   flags: 'uint32'
 * })
 *
 * const shm = new SharedMemory('GameState', layout)
 * shm.open()
 * const data = shm.readStruct()
 * shm.writeField('progress', 0.75)
 * shm.close()
 * ```
 */

import koffi, { type IKoffiCType } from "koffi";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sentinel value for pagefile-backed file mappings (no backing file). */
const INVALID_HANDLE_VALUE = -1;

/** Read/write access for CreateFileMappingW. */
const PAGE_READWRITE = 0x04;

/** Full read/write/execute access for MapViewOfFile. */
const FILE_MAP_ALL_ACCESS = 0x001f;

/** GetLastError code indicating the mapping already existed. */
const ERROR_ALREADY_EXISTS = 183;

/** WaitForSingleObject return: the object was signalled. */
const WAIT_OBJECT_0 = 0x00000000;

// ---------------------------------------------------------------------------
// Win32 FFI bindings (lazy-loaded)
// ---------------------------------------------------------------------------

let _kernel32: ReturnType<typeof koffi.load> | null = null;

function kernel32(): ReturnType<typeof koffi.load> {
  if (!_kernel32) {
    _kernel32 = koffi.load("kernel32.dll");
  }
  return _kernel32;
}

interface Win32Api {
  CreateFileMappingW: (
    hFile: number,
    lpAttr: null,
    flProtect: number,
    dwMaxHigh: number,
    dwMaxLow: number,
    lpName: string,
  ) => unknown;
  OpenFileMappingW: (dwDesiredAccess: number, bInheritHandle: number, lpName: string) => unknown;
  MapViewOfFile: (
    hMapping: unknown,
    dwDesiredAccess: number,
    dwOffsetHigh: number,
    dwOffsetLow: number,
    dwBytes: number,
  ) => unknown;
  UnmapViewOfFile: (lpBase: unknown) => number;
  CloseHandle: (hObject: unknown) => number;
  CreateMutexW: (lpAttr: null, bInitialOwner: number, lpName: string | null) => unknown;
  WaitForSingleObject: (hHandle: unknown, dwMs: number) => number;
  ReleaseMutex: (hMutex: unknown) => number;
  RtlMoveMemory: (dest: unknown, src: Buffer, length: number) => void;
  GetLastError: () => number;
}

let _api: Win32Api | null = null;

function api(): Win32Api {
  if (!_api) {
    const k = kernel32();
    _api = {
      CreateFileMappingW: k.func(
        "void* __stdcall CreateFileMappingW(intptr_t, void*, uint32_t, uint32_t, uint32_t, str16)",
      ),
      OpenFileMappingW: k.func("void* __stdcall OpenFileMappingW(uint32_t, int32_t, str16)"),
      MapViewOfFile: k.func(
        "void* __stdcall MapViewOfFile(void*, uint32_t, uint32_t, uint32_t, uintptr_t)",
      ),
      UnmapViewOfFile: k.func("int32_t __stdcall UnmapViewOfFile(void*)"),
      CloseHandle: k.func("int32_t __stdcall CloseHandle(void*)"),
      CreateMutexW: k.func("void* __stdcall CreateMutexW(void*, int32_t, str16)"),
      WaitForSingleObject: k.func("uint32_t __stdcall WaitForSingleObject(void*, uint32_t)"),
      ReleaseMutex: k.func("int32_t __stdcall ReleaseMutex(void*)"),
      RtlMoveMemory: k.func("void __stdcall RtlMoveMemory(void*, const void*, uintptr_t)"),
      GetLastError: k.func("uint32_t __stdcall GetLastError()"),
    };
  }
  return _api;
}

// ---------------------------------------------------------------------------
// SharedMemory class
// ---------------------------------------------------------------------------

/**
 * Cross-process shared memory region backed by a Win32 named file mapping.
 *
 * Matches FxDK's `HostSharedData<T>` naming convention so the game client
 * and SDK host can communicate through the same shared memory segments.
 *
 * @typeParam T - A koffi struct type describing the shared data layout.
 */
export class SharedMemory {
  private readonly mappingName: string;
  private readonly size: number;
  private readonly structType: IKoffiCType;

  private hMapping: unknown = null;
  private viewPtr: unknown = null;
  private hMutex: unknown = null;
  private _isCreator = false;

  /**
   * @param name       - Logical name of the shared data (e.g. "GameState").
   * @param structType - A koffi struct type created via `koffi.struct(...)`.
   * @param options    - Optional overrides for launch mode and product key.
   */
  constructor(
    name: string,
    structType: IKoffiCType,
    options?: { launchMode?: string; productKey?: string },
  ) {
    const launchMode = options?.launchMode ?? "fxdk";
    const productKey = options?.productKey ?? "CFXGame";
    this.mappingName = `CFX_${launchMode}_${productKey}_SharedData_${name}`;
    this.structType = structType;
    this.size = koffi.sizeof(structType);
  }

  /**
   * The Win32 name used for the file mapping object.
   * Useful for diagnostics or when another process needs the exact name.
   */
  get name(): string {
    return this.mappingName;
  }

  /**
   * Whether this instance created the mapping (vs. opening an existing one).
   */
  get isCreator(): boolean {
    return this._isCreator;
  }

  /**
   * Open (or create) the shared memory region and map it into this process.
   *
   * If a mapping with the same name already exists, it is opened rather
   * than created. The `isCreator` property reflects which case occurred.
   *
   * @throws {Error} If CreateFileMappingW or MapViewOfFile fails.
   */
  open(): void {
    if (this.viewPtr) return; // already open

    const w = api();

    // Try to create — if it already exists we still get a valid handle.
    this.hMapping = w.CreateFileMappingW(
      INVALID_HANDLE_VALUE,
      null,
      PAGE_READWRITE,
      0,
      this.size,
      this.mappingName,
    );

    if (!this.hMapping) {
      // Mapping may already exist — try opening instead.
      this.hMapping = w.OpenFileMappingW(FILE_MAP_ALL_ACCESS, 0, this.mappingName);
      if (!this.hMapping) {
        throw new Error(
          `Failed to create or open file mapping "${this.mappingName}" (GetLastError=${w.GetLastError()})`,
        );
      }
      this._isCreator = false;
    } else {
      this._isCreator = w.GetLastError() !== ERROR_ALREADY_EXISTS;
    }

    this.viewPtr = w.MapViewOfFile(this.hMapping, FILE_MAP_ALL_ACCESS, 0, 0, this.size);
    if (!this.viewPtr) {
      const err = w.GetLastError();
      w.CloseHandle(this.hMapping);
      this.hMapping = null;
      throw new Error(`MapViewOfFile failed for "${this.mappingName}" (GetLastError=${err})`);
    }

    // Create a named mutex for synchronized access.
    this.hMutex = w.CreateMutexW(null, 0, `${this.mappingName}_Mutex`);
  }

  /**
   * Close the shared memory mapping and release all Win32 handles.
   * Safe to call multiple times.
   */
  close(): void {
    const w = api();

    if (this.viewPtr) {
      w.UnmapViewOfFile(this.viewPtr);
      this.viewPtr = null;
    }
    if (this.hMapping) {
      w.CloseHandle(this.hMapping);
      this.hMapping = null;
    }
    if (this.hMutex) {
      w.CloseHandle(this.hMutex);
      this.hMutex = null;
    }
  }

  /** Whether the shared memory region is currently mapped. */
  isOpen(): boolean {
    return this.viewPtr !== null;
  }

  // -----------------------------------------------------------------------
  // Raw byte access
  // -----------------------------------------------------------------------

  /**
   * Read raw bytes from the mapped view.
   *
   * @param offset - Byte offset from the start of the mapping.
   * @param length - Number of bytes to read.
   * @returns A Buffer containing the requested bytes.
   */
  read(offset: number, length: number): Buffer {
    this.ensureOpen();
    const arrayType = koffi.array("uint8_t", this.size);
    const bytes = koffi.decode(this.viewPtr, arrayType) as Uint8Array;
    return Buffer.from(bytes.buffer, bytes.byteOffset + offset, length);
  }

  /**
   * Write raw bytes into the mapped view.
   *
   * @param offset - Byte offset from the start of the mapping.
   * @param data   - Buffer containing the bytes to write.
   */
  write(offset: number, data: Buffer): void {
    this.ensureOpen();
    // Read the full region, splice in the new data, write back via RtlMoveMemory.
    // NOTE: koffi.encode segfaults on MapViewOfFile pointers with large sizes (koffi bug).
    const arrayType = koffi.array("uint8_t", this.size);
    const current = koffi.decode(this.viewPtr, arrayType) as Uint8Array;
    const merged = Buffer.from(current);
    data.copy(merged, offset);
    api().RtlMoveMemory(this.viewPtr, merged, this.size);
  }

  // -----------------------------------------------------------------------
  // Struct access
  // -----------------------------------------------------------------------

  /**
   * Read the entire shared memory region as a typed struct.
   *
   * @returns A plain JS object matching the struct layout.
   */
  readStruct(): Record<string, unknown> {
    this.ensureOpen();
    return koffi.decode(this.viewPtr, this.structType) as Record<string, unknown>;
  }

  /**
   * Write a complete struct into the shared memory region.
   *
   * @param value - An object whose keys match the struct field names.
   */
  writeStruct(value: Record<string, unknown>): void {
    this.ensureOpen();
    koffi.encode(this.viewPtr, this.structType, value);
  }

  /**
   * Update a single field in the shared memory struct (read-modify-write).
   *
   * @param fieldName - Name of the struct field to update.
   * @param value     - New value for the field.
   */
  writeField(fieldName: string, value: unknown): void {
    this.ensureOpen();
    const current = this.readStruct();
    if (!(fieldName in current)) {
      throw new Error(`Unknown field "${fieldName}" in shared memory struct`);
    }
    current[fieldName] = value;
    this.writeStruct(current);
  }

  // -----------------------------------------------------------------------
  // Synchronized access
  // -----------------------------------------------------------------------

  /**
   * Acquire the mutex, execute `fn`, then release the mutex.
   * Ensures exclusive access to the shared memory region across processes.
   *
   * @param fn      - Callback to execute while holding the lock.
   * @param timeout - Maximum wait in milliseconds (default: 5000).
   * @returns The return value of `fn`.
   */
  withLock<R>(fn: () => R, timeout = 5000): R {
    this.ensureOpen();
    if (!this.hMutex) {
      throw new Error("Mutex not initialized — call open() first");
    }

    const w = api();
    const waitResult = w.WaitForSingleObject(this.hMutex, timeout);
    if (waitResult !== WAIT_OBJECT_0) {
      throw new Error(
        `Failed to acquire mutex for "${this.mappingName}" (WaitForSingleObject=${waitResult})`,
      );
    }

    try {
      return fn();
    } finally {
      w.ReleaseMutex(this.hMutex);
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private ensureOpen(): void {
    if (!this.viewPtr) {
      throw new Error(`SharedMemory "${this.mappingName}" is not open — call open() first`);
    }
  }
}
