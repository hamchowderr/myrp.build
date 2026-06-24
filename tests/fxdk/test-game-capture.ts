/**
 * D3D11 shared texture capture proof-of-concept.
 * Proves that we can read pixels from D3D11 shared textures using pure Koffi (no native addon).
 *
 * Run: npx tsx tests/fxdk/test-game-capture.ts
 *
 * Flow:
 *   1. Create D3D11 device A (producer — simulates FiveM game)
 *   2. Create a 64x64 BGRA shared texture, fill with known pixel gradient
 *   3. Get DXGI shared handle via IDXGIResource::GetSharedHandle
 *   4. Create D3D11 device B (consumer — simulates our capture)
 *   5. Call captureFrameFromHandle() to read pixels via device B
 *   6. Verify pixel data matches the expected gradient pattern
 */

import koffi from "koffi";
import {
  captureFrameFromHandle,
  comCall,
  createD3D11Device,
  D3D11_BIND_SHADER_RESOURCE,
  D3D11_RESOURCE_MISC_SHARED,
  D3D11_USAGE_DEFAULT,
  type D3D11DeviceAndContext,
  DXGI_FORMAT_B8G8R8A8_UNORM,
  IID_IDXGIResource,
  releaseComPtr,
} from "../../src/main/fxdk/game-view";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEX_WIDTH = 64;
const TEX_HEIGHT = 64;
const TEX_BPP = 4; // BGRA

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function pass(msg: string): void {
  passed++;
  console.log(`  [PASS] ${msg}`);
}

function fail(msg: string): void {
  failed++;
  console.log(`  [FAIL] ${msg}`);
}

function info(msg: string): void {
  console.log(`  [INFO] ${msg}`);
}

/**
 * Build the expected pixel buffer: red/green gradient.
 * For pixel (x, y): B=0, G=y*4, R=x*4, A=255
 */
function buildExpectedPixels(): Buffer {
  const buf = Buffer.alloc(TEX_WIDTH * TEX_HEIGHT * TEX_BPP);
  for (let y = 0; y < TEX_HEIGHT; y++) {
    for (let x = 0; x < TEX_WIDTH; x++) {
      const offset = (y * TEX_WIDTH + x) * TEX_BPP;
      buf[offset + 0] = 0; // B
      buf[offset + 1] = y * 4; // G (0..252)
      buf[offset + 2] = x * 4; // R (0..252)
      buf[offset + 3] = 255; // A
    }
  }
  return buf;
}

/**
 * Check a single pixel with tolerance.
 */
function checkPixel(
  pixels: Buffer,
  x: number,
  y: number,
  expectedB: number,
  expectedG: number,
  expectedR: number,
  expectedA: number,
  tolerance = 1,
): boolean {
  const offset = (y * TEX_WIDTH + x) * TEX_BPP;
  const b = pixels[offset + 0];
  const g = pixels[offset + 1];
  const r = pixels[offset + 2];
  const a = pixels[offset + 3];

  const ok =
    Math.abs(b - expectedB) <= tolerance &&
    Math.abs(g - expectedG) <= tolerance &&
    Math.abs(r - expectedR) <= tolerance &&
    Math.abs(a - expectedA) <= tolerance;

  if (!ok) {
    info(
      `  Pixel (${x},${y}): got BGRA=(${b},${g},${r},${a}), expected (${expectedB},${expectedG},${expectedR},${expectedA})`,
    );
  }

  return ok;
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("D3D11 Shared Texture Capture — Proof of Concept");
  console.log("════════════════════════════════════════════════");

  let deviceA: D3D11DeviceAndContext | null = null;
  let deviceB: D3D11DeviceAndContext | null = null;
  let ppTexture: Buffer | null = null;
  let ppDxgiResource: Buffer | null = null;

  try {
    // ─── Test 1: Create producer device (device A) ────────────────────
    console.log("\n═══ Test 1: Create producer device (device A) ═══");

    deviceA = createD3D11Device();
    if (deviceA) {
      pass("createD3D11Device() returned device A");
    } else {
      fail("createD3D11Device() returned null — D3D11 not available");
      console.log("\n  Cannot continue without D3D11. Exiting.");
      return;
    }

    // ─── Test 2: Create 64x64 shared texture and fill with pixel data ─
    console.log("\n═══ Test 2: Create shared texture and fill with pixel data ═══");

    // Build D3D11_TEXTURE2D_DESC (44 bytes)
    const desc = Buffer.alloc(44);
    desc.writeUInt32LE(TEX_WIDTH, 0); // Width
    desc.writeUInt32LE(TEX_HEIGHT, 4); // Height
    desc.writeUInt32LE(1, 8); // MipLevels
    desc.writeUInt32LE(1, 12); // ArraySize
    desc.writeUInt32LE(DXGI_FORMAT_B8G8R8A8_UNORM, 16); // Format
    desc.writeUInt32LE(1, 20); // SampleDesc.Count
    desc.writeUInt32LE(0, 24); // SampleDesc.Quality
    desc.writeUInt32LE(D3D11_USAGE_DEFAULT, 28); // Usage
    desc.writeUInt32LE(D3D11_BIND_SHADER_RESOURCE, 32); // BindFlags
    desc.writeUInt32LE(0, 36); // CPUAccessFlags
    desc.writeUInt32LE(D3D11_RESOURCE_MISC_SHARED, 40); // MiscFlags

    // ID3D11Device::CreateTexture2D — vtable index 5
    // HRESULT CreateTexture2D(const D3D11_TEXTURE2D_DESC*, const D3D11_SUBRESOURCE_DATA*, ID3D11Texture2D**)
    ppTexture = Buffer.alloc(8);
    const hrCreate = comCall(
      deviceA.device,
      5,
      "int32",
      ["void *", "void *", "void *", "void **"],
      [deviceA.device, desc, null, ppTexture],
    ) as number;

    if (hrCreate < 0) {
      fail(`CreateTexture2D failed: HRESULT 0x${(hrCreate >>> 0).toString(16)}`);
      return;
    }
    pass("CreateTexture2D (shared, 64x64 BGRA)");

    const pTexture = koffi.decode(ppTexture, "void *");

    // Fill with pixel data using UpdateSubresource
    // ID3D11DeviceContext::UpdateSubresource — vtable index 48
    // void UpdateSubresource(ID3D11Resource *pDstResource, UINT DstSubresource,
    //   const D3D11_BOX *pDstBox, const void *pSrcData, UINT SrcRowPitch, UINT SrcDepthPitch)
    const pixelData = buildExpectedPixels();
    const rowPitch = TEX_WIDTH * TEX_BPP; // 256

    comCall(
      deviceA.context,
      48,
      "void",
      ["void *", "void *", "uint32", "void *", "void *", "uint32", "uint32"],
      [deviceA.context, pTexture, 0, null, pixelData, rowPitch, 0],
    );

    pass(`UpdateSubresource — filled ${TEX_WIDTH}x${TEX_HEIGHT} with gradient`);

    // Force GPU to execute UpdateSubresource by doing a same-device
    // staging copy + Map/Unmap. This synchronizes the GPU pipeline.
    // (ClearState at vtable 101 was being called instead of Flush — it doesn't flush.)
    {
      const syncDesc = Buffer.alloc(44);
      syncDesc.writeUInt32LE(TEX_WIDTH, 0);
      syncDesc.writeUInt32LE(TEX_HEIGHT, 4);
      syncDesc.writeUInt32LE(1, 8);
      syncDesc.writeUInt32LE(1, 12);
      syncDesc.writeUInt32LE(DXGI_FORMAT_B8G8R8A8_UNORM, 16);
      syncDesc.writeUInt32LE(1, 20);
      syncDesc.writeUInt32LE(0, 24);
      syncDesc.writeUInt32LE(3, 28); // STAGING
      syncDesc.writeUInt32LE(0, 32);
      syncDesc.writeUInt32LE(0x20000, 36); // CPU_ACCESS_READ
      syncDesc.writeUInt32LE(0, 40);
      const ppSync = Buffer.alloc(8);
      comCall(
        deviceA.device,
        5,
        "int32",
        ["void *", "void *", "void *", "void **"],
        [deviceA.device, syncDesc, null, ppSync],
      );
      const syncTex = koffi.decode(ppSync, "void *");
      comCall(
        deviceA.context,
        47,
        "void",
        ["void *", "void *", "void *"],
        [deviceA.context, syncTex, pTexture],
      );
      const syncMapped = Buffer.alloc(16);
      comCall(
        deviceA.context,
        14,
        "int32",
        ["void *", "void *", "uint32", "int32", "uint32", "void *"],
        [deviceA.context, syncTex, 0, 1, 0, syncMapped],
      );
      comCall(
        deviceA.context,
        15,
        "void",
        ["void *", "void *", "uint32"],
        [deviceA.context, syncTex, 0],
      );
      comCall(syncTex, 2, "uint32", ["void *"], [syncTex]);
    }
    pass("GPU sync — producer pipeline drained via same-device Map/Unmap");

    // ─── Test 3: Get shared handle via IDXGIResource::GetSharedHandle ─
    console.log("\n═══ Test 3: Get shared handle via IDXGIResource::GetSharedHandle ═══");

    // QueryInterface for IDXGIResource (IUnknown::QueryInterface = vtable 0)
    // HRESULT QueryInterface(REFIID riid, void **ppvObject)
    ppDxgiResource = Buffer.alloc(8);
    const hrQI = comCall(
      pTexture,
      0,
      "int32",
      ["void *", "void *", "void **"],
      [pTexture, IID_IDXGIResource, ppDxgiResource],
    ) as number;

    if (hrQI < 0) {
      fail(`QueryInterface(IDXGIResource) failed: HRESULT 0x${(hrQI >>> 0).toString(16)}`);
      return;
    }
    pass("QueryInterface for IDXGIResource");

    const pDxgiResource = koffi.decode(ppDxgiResource, "void *");

    // IDXGIResource::GetSharedHandle — vtable index 8
    // HRESULT GetSharedHandle(HANDLE *pSharedHandle)
    const ppHandle = Buffer.alloc(8);
    const hrHandle = comCall(
      pDxgiResource,
      8,
      "int32",
      ["void *", "void **"],
      [pDxgiResource, ppHandle],
    ) as number;

    if (hrHandle < 0) {
      fail(`GetSharedHandle failed: HRESULT 0x${(hrHandle >>> 0).toString(16)}`);
      return;
    }

    const sharedHandle = koffi.decode(ppHandle, "void *");
    if (!sharedHandle) {
      fail("GetSharedHandle returned null handle");
      return;
    }
    pass(`GetSharedHandle returned handle`);

    // ─── Test 4: Create consumer device (device B) ────────────────────
    console.log("\n═══ Test 4: Create consumer device (device B) ═══");

    deviceB = createD3D11Device();
    if (deviceB) {
      pass("createD3D11Device() returned device B");
    } else {
      fail("createD3D11Device() returned null for device B");
      return;
    }

    // ─── Test 5: Capture frame from shared handle ─────────────────────
    console.log("\n═══ Test 5: Capture frame from shared handle ═══");

    const capturedPixels = captureFrameFromHandle(deviceB, sharedHandle, TEX_WIDTH, TEX_HEIGHT);

    if (capturedPixels) {
      pass(
        `captureFrameFromHandle returned ${capturedPixels.length} bytes (expected ${TEX_WIDTH * TEX_HEIGHT * TEX_BPP})`,
      );
    } else {
      fail("captureFrameFromHandle returned null");
      return;
    }

    // ─── Test 6: Verify pixel data ────────────────────────────────────
    console.log("\n═══ Test 6: Verify pixel data ═══");

    const checks = [
      { x: 0, y: 0, b: 0, g: 0, r: 0, a: 255, label: "(0,0) black corner" },
      {
        x: 63,
        y: 0,
        b: 0,
        g: 0,
        r: 252,
        a: 255,
        label: "(63,0) red edge",
      },
      {
        x: 0,
        y: 63,
        b: 0,
        g: 252,
        r: 0,
        a: 255,
        label: "(0,63) green edge",
      },
      {
        x: 63,
        y: 63,
        b: 0,
        g: 252,
        r: 252,
        a: 255,
        label: "(63,63) yellow corner",
      },
      {
        x: 32,
        y: 32,
        b: 0,
        g: 128,
        r: 128,
        a: 255,
        label: "(32,32) midpoint",
      },
    ];

    for (const c of checks) {
      const ok = checkPixel(capturedPixels, c.x, c.y, c.b, c.g, c.r, c.a);
      if (ok) {
        pass(`Pixel ${c.label}: BGRA=(${c.b},${c.g},${c.r},${c.a})`);
      } else {
        fail(`Pixel ${c.label}: expected BGRA=(${c.b},${c.g},${c.r},${c.a})`);
      }
    }
  } catch (err) {
    fail(`Unexpected error: ${err}`);
    if (err instanceof Error && err.stack) {
      info(err.stack);
    }
  } finally {
    // ─── Cleanup ──────────────────────────────────────────────────────
    console.log("\n═══ Cleanup ═══");

    try {
      if (ppDxgiResource) {
        releaseComPtr(ppDxgiResource);
        info("Released IDXGIResource");
      }
    } catch {
      info("Failed to release IDXGIResource (best-effort)");
    }

    try {
      if (ppTexture) {
        releaseComPtr(ppTexture);
        info("Released shared texture");
      }
    } catch {
      info("Failed to release shared texture (best-effort)");
    }

    try {
      if (deviceA) {
        releaseComPtr(deviceA.ppContext);
        releaseComPtr(deviceA.ppDevice);
        info("Released device A");
      }
    } catch {
      info("Failed to release device A (best-effort)");
    }

    try {
      if (deviceB) {
        releaseComPtr(deviceB.ppContext);
        releaseComPtr(deviceB.ppDevice);
        info("Released device B");
      }
    } catch {
      info("Failed to release device B (best-effort)");
    }

    // ─── Summary ──────────────────────────────────────────────────────
    console.log("\n════════════════════════════════════════════════");
    console.log(`Done. ${passed} passed, ${failed} failed.`);
    if (failed === 0) {
      console.log(
        "SUCCESS: Pure Koffi D3D11 shared texture capture works — no native addon needed.",
      );
    }
  }
}

main().catch(console.error);
