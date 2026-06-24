import koffi from "koffi";

// ---------------------------------------------------------------------------
// D3D11 enums & constants
// ---------------------------------------------------------------------------

export const DXGI_FORMAT_B8G8R8A8_UNORM = 87;
export const D3D11_USAGE_DEFAULT = 0;
export const D3D11_USAGE_STAGING = 3;
export const D3D11_BIND_SHADER_RESOURCE = 0x8;
export const D3D11_RESOURCE_MISC_SHARED = 0x2;
export const D3D11_CPU_ACCESS_READ = 0x20000;
export const D3D11_MAP_READ = 1;
export const D3D_DRIVER_TYPE_HARDWARE = 1;
export const D3D11_SDK_VERSION = 7;

// IID byte arrays (little-endian GUIDs)
// IID_ID3D11Texture2D = {6f15aaf2-d208-4e89-9ab4-489535d34f9c}
export const IID_ID3D11Texture2D = Buffer.from([
  0xf2, 0xaa, 0x15, 0x6f, 0x08, 0xd2, 0x89, 0x4e, 0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c,
]);
// IID_IDXGIResource = {035f3ab4-482e-4e50-b41f-8a7f8bd8960b}
export const IID_IDXGIResource = Buffer.from([
  0xb4, 0x3a, 0x5f, 0x03, 0x2e, 0x48, 0x50, 0x4e, 0xb4, 0x1f, 0x8a, 0x7f, 0x8b, 0xd8, 0x96, 0x0b,
]);

// ---------------------------------------------------------------------------
// COM vtable helpers
// ---------------------------------------------------------------------------

/**
 * Read a koffi opaque pointer at a byte offset from a base pointer.
 * Uses the BigInt coercion approach (consistent with existing releaseComPtr).
 */
export function readPtrAtOffset(basePtr: unknown, byteOffset: bigint): unknown {
  const addr = koffi.address(basePtr) + byteOffset;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(addr);
  return koffi.decode(buf, "void *");
}

let _comCallCounter = 0;

/**
 * Call a COM method by vtable index.
 *
 * @param pObj        - The COM interface pointer (opaque koffi pointer)
 * @param vtableIndex - 0-based index into the vtable
 * @param retType     - Return type string for koffi (e.g. "int32", "uint32", "void")
 * @param argTypes    - Argument type strings (first is always "void *" for `this`)
 * @param args        - Arguments to pass (first should be pObj itself)
 */
export function comCall(
  pObj: unknown,
  vtableIndex: number,
  retType: string,
  argTypes: string[],
  args: unknown[],
): unknown {
  // COM object pointer → vtable pointer (first pointer at *pObj)
  const pVtable = koffi.decode(pObj, "void *");

  // Function pointer lives at vtable + index * 8 (x64)
  const vtableEntry = readPtrAtOffset(pVtable, BigInt(vtableIndex) * 8n);

  // Dereference the vtable entry to get the actual function pointer
  const fnPtr = koffi.decode(vtableEntry, "void *");

  // Build stdcall prototype with unique name and invoke via koffi.call
  const protoName = `comVtable_${_comCallCounter++}`;
  const proto = koffi.proto(`${retType} __stdcall ${protoName}(${argTypes.join(", ")})`);
  return koffi.call(fnPtr, proto, ...args);
}

/**
 * Calls IUnknown::Release on a COM pointer stored in an 8-byte buffer.
 * IUnknown::Release is vtable slot 2 (0-indexed).
 */
export function releaseComPtr(ppObj: Buffer): void {
  try {
    // ppObj is a Buffer holding a void* (the COM interface pointer)
    const pObj = koffi.decode(ppObj, "void *");
    if (!pObj) return;

    // COM interface pointer → vtable pointer (first 8 bytes at *pObj)
    const pVtable = koffi.decode(pObj, "void *");
    if (!pVtable) return;

    // Use comCall for Release (vtable index 2): uint32 Release(void *this)
    comCall(pObj, 2, "uint32", ["void *"], [pObj]);
  } catch {
    // Best-effort cleanup — if this fails the probe still succeeds
  }
}

// ---------------------------------------------------------------------------
// D3D11 device creation
// ---------------------------------------------------------------------------

export interface D3D11DeviceAndContext {
  device: unknown; // ID3D11Device*
  context: unknown; // ID3D11DeviceContext*
  ppDevice: Buffer; // Raw buffer holding the pointer (for release)
  ppContext: Buffer; // Raw buffer holding the pointer (for release)
}

// Cache d3d11.dll function binding so multiple createD3D11Device() calls
// share the same DLL handle (required for cross-device DXGI sharing to work).
let _d3d11CreateDevice: ReturnType<koffi.IKoffiLib["func"]> | null = null;

export function getD3D11CreateDevice() {
  if (!_d3d11CreateDevice) {
    const d3d11 = koffi.load("d3d11.dll");
    _d3d11CreateDevice = d3d11.func("D3D11CreateDevice", "int32", [
      "void *", // pAdapter
      "int32", // DriverType
      "void *", // Software
      "uint32", // Flags
      "void *", // pFeatureLevels
      "uint32", // FeatureLevels
      "uint32", // SDKVersion
      "void **", // ppDevice
      "void *", // pFeatureLevel
      "void **", // ppImmediateContext
    ]);
  }
  return _d3d11CreateDevice;
}

/**
 * Create a D3D11 hardware device and immediate context.
 * Returns null if device creation fails.
 * The caller is responsible for releasing via `releaseComPtr(ppDevice)` / `releaseComPtr(ppContext)`.
 */
export function createD3D11Device(): D3D11DeviceAndContext | null {
  try {
    const D3D11CreateDevice = getD3D11CreateDevice();

    const ppDevice = Buffer.alloc(8);
    const ppContext = Buffer.alloc(8);

    const hr: number = D3D11CreateDevice(
      null,
      D3D_DRIVER_TYPE_HARDWARE,
      null,
      0,
      null,
      0,
      D3D11_SDK_VERSION,
      ppDevice,
      null,
      ppContext,
    );

    if (hr < 0) return null;

    const device = koffi.decode(ppDevice, "void *");
    const context = koffi.decode(ppContext, "void *");
    return { device, context, ppDevice, ppContext };
  } catch {
    return null;
  }
}

/**
 * Attempts to call D3D11CreateDevice to verify that a D3D11 device can be
 * created on this machine.  This is a lightweight probe — the device is
 * released immediately.
 *
 * Returns `true` when a device was successfully created.
 */
export function probeD3D11Device(): boolean {
  try {
    const D3D11CreateDevice = getD3D11CreateDevice();

    const ppDevice = Buffer.alloc(8);
    const ppContext = Buffer.alloc(8);

    const hr: number = D3D11CreateDevice(
      null, // default adapter
      D3D_DRIVER_TYPE_HARDWARE,
      null,
      0,
      null,
      0,
      D3D11_SDK_VERSION,
      ppDevice,
      null,
      ppContext,
    );

    if (hr < 0) {
      return false;
    }

    // Release device and context via COM Release (vtable index 2)
    releaseComPtr(ppDevice);
    releaseComPtr(ppContext);

    return true;
  } catch {
    return false;
  }
}
