import koffi from "koffi";
import {
  comCall,
  D3D11_CPU_ACCESS_READ,
  D3D11_MAP_READ,
  D3D11_USAGE_STAGING,
  type D3D11DeviceAndContext,
  DXGI_FORMAT_B8G8R8A8_UNORM,
  IID_ID3D11Texture2D,
  releaseComPtr,
} from "./d3d11-helpers";

// ---------------------------------------------------------------------------
// Frame capture from DXGI shared handle
// ---------------------------------------------------------------------------

/**
 * Capture pixels from a DXGI shared texture handle.
 *
 * Creates a staging texture on the provided device, copies the shared texture
 * into it, maps the staging texture, and reads BGRA pixels into a Node.js Buffer.
 *
 * @param deviceCtx - D3D11 device and context (from `createD3D11Device()`)
 * @param handle    - DXGI shared handle (from IDXGIResource::GetSharedHandle or ReverseGameData)
 * @param width     - Expected texture width in pixels
 * @param height    - Expected texture height in pixels
 * @returns Buffer of BGRA pixels (width * height * 4 bytes), or null on failure
 */
export function captureFrameFromHandle(
  deviceCtx: D3D11DeviceAndContext,
  handle: unknown,
  width: number,
  height: number,
): Buffer | null {
  const { device, context } = deviceCtx;
  let ppSharedTex: Buffer | null = null;
  let ppStaging: Buffer | null = null;

  try {
    // 1. Open shared resource as ID3D11Texture2D
    // ID3D11Device::OpenSharedResource — vtable index 28
    // HRESULT OpenSharedResource(HANDLE hResource, REFIID ReturnedInterface, void **ppResource)
    ppSharedTex = Buffer.alloc(8);
    const hr1 = comCall(
      device,
      28,
      "int32",
      ["void *", "void *", "void *", "void **"],
      [device, handle, IID_ID3D11Texture2D, ppSharedTex],
    ) as number;
    if (hr1 < 0) return null;
    const sharedTex = koffi.decode(ppSharedTex, "void *");

    // 2. Create staging texture
    // D3D11_TEXTURE2D_DESC layout (44 bytes):
    //   Width(4) Height(4) MipLevels(4) ArraySize(4) Format(4)
    //   SampleDesc.Count(4) SampleDesc.Quality(4)
    //   Usage(4) BindFlags(4) CPUAccessFlags(4) MiscFlags(4)
    const descBuf = Buffer.alloc(44);
    descBuf.writeUInt32LE(width, 0); // Width
    descBuf.writeUInt32LE(height, 4); // Height
    descBuf.writeUInt32LE(1, 8); // MipLevels
    descBuf.writeUInt32LE(1, 12); // ArraySize
    descBuf.writeUInt32LE(DXGI_FORMAT_B8G8R8A8_UNORM, 16); // Format
    descBuf.writeUInt32LE(1, 20); // SampleDesc.Count
    descBuf.writeUInt32LE(0, 24); // SampleDesc.Quality
    descBuf.writeUInt32LE(D3D11_USAGE_STAGING, 28); // Usage
    descBuf.writeUInt32LE(0, 32); // BindFlags (0 for staging)
    descBuf.writeUInt32LE(D3D11_CPU_ACCESS_READ, 36); // CPUAccessFlags
    descBuf.writeUInt32LE(0, 40); // MiscFlags

    // ID3D11Device::CreateTexture2D — vtable index 5
    // HRESULT CreateTexture2D(const D3D11_TEXTURE2D_DESC*, const D3D11_SUBRESOURCE_DATA*, ID3D11Texture2D**)
    ppStaging = Buffer.alloc(8);
    const hr2 = comCall(
      device,
      5,
      "int32",
      ["void *", "void *", "void *", "void **"],
      [device, descBuf, null, ppStaging],
    ) as number;
    if (hr2 < 0) {
      releaseComPtr(ppSharedTex);
      return null;
    }
    const staging = koffi.decode(ppStaging, "void *");

    // 3. CopyResource(staging, shared)
    // ID3D11DeviceContext::CopyResource — vtable index 47
    // void CopyResource(ID3D11Resource *pDstResource, ID3D11Resource *pSrcResource)
    comCall(context, 47, "void", ["void *", "void *", "void *"], [context, staging, sharedTex]);

    // 4. Map staging texture
    // ID3D11DeviceContext::Map — vtable index 14
    // HRESULT Map(ID3D11Resource*, UINT Subresource, D3D11_MAP MapType, UINT MapFlags, D3D11_MAPPED_SUBRESOURCE*)
    // D3D11_MAPPED_SUBRESOURCE = { pData: void* (8), RowPitch: uint32 (4), DepthPitch: uint32 (4) } = 16 bytes
    const mappedBuf = Buffer.alloc(16);
    const hr3 = comCall(
      context,
      14,
      "int32",
      ["void *", "void *", "uint32", "int32", "uint32", "void *"],
      [context, staging, 0, D3D11_MAP_READ, 0, mappedBuf],
    ) as number;
    if (hr3 < 0) {
      releaseComPtr(ppStaging);
      releaseComPtr(ppSharedTex);
      return null;
    }

    // 5. Read mapped data into a Node.js Buffer
    const pData = koffi.decode(mappedBuf, "void *"); // First 8 bytes = pData pointer
    const rowPitch = mappedBuf.readUInt32LE(8);
    const expectedRowBytes = width * 4; // BGRA = 4 bytes per pixel

    // Decode the entire mapped region as a flat uint8 array
    const totalMappedBytes = rowPitch * height;
    const allData: number[] = koffi.decode(
      pData,
      koffi.array("uint8", totalMappedBytes),
    ) as number[];

    // Copy with row pitch stride handling (rowPitch may be > width * 4)
    const pixelBuffer = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      const srcRowStart = y * rowPitch;
      const dstRowStart = y * expectedRowBytes;
      for (let x = 0; x < expectedRowBytes; x++) {
        pixelBuffer[dstRowStart + x] = allData[srcRowStart + x];
      }
    }

    // 6. Unmap
    // ID3D11DeviceContext::Unmap — vtable index 15
    comCall(context, 15, "void", ["void *", "void *", "uint32"], [context, staging, 0]);

    // 7. Release shared and staging textures
    releaseComPtr(ppStaging);
    releaseComPtr(ppSharedTex);

    return pixelBuffer;
  } catch {
    // Best-effort cleanup
    if (ppStaging) releaseComPtr(ppStaging);
    if (ppSharedTex) releaseComPtr(ppSharedTex);
    return null;
  }
}
