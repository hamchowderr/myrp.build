import koffi from "koffi";
import {
  createD3D11Device,
  type D3D11DeviceAndContext,
  probeD3D11Device,
  releaseComPtr,
} from "./d3d11-helpers";
import { captureFrameFromHandle } from "./frame-capture";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GameViewOptions {
  /** Frame width in pixels */
  width: number;
  /** Frame height in pixels */
  height: number;
  /** Prefer GPU shared-texture path when available */
  preferGpu: boolean;
}

/** Raw BGRA frame delivered to the renderer */
export interface FrameData {
  /** Raw BGRA pixel buffer (4 bytes per pixel, row-major) */
  buffer: Buffer;
  width: number;
  height: number;
  /** performance.now() timestamp when the frame was captured */
  timestamp: number;
}

export type RenderBackend = "gpu" | "cpu" | "none";

export interface CapabilityReport {
  gpuAvailable: boolean;
  cpuAvailable: boolean;
  /** Human-readable explanation when a path is unavailable */
  reason?: string;
}

export interface FrameStats {
  fps: number;
  backend: RenderBackend;
  droppedFrames: number;
}

type FrameCallback = (frame: FrameData) => void;

// ---------------------------------------------------------------------------
// Win32 constants
// ---------------------------------------------------------------------------

const GV_WAIT_TIMEOUT = 0x00000102;
const GV_WAIT_FAILED = 0xffffffff;

/** Timeout (ms) when waiting on the consume semaphore each tick. */
const SEMA_WAIT_MS = 16; // ~60 fps budget

// ---------------------------------------------------------------------------
// Koffi — kernel32 sync primitives
// ---------------------------------------------------------------------------

let _kernel32: koffi.IKoffiLib | null = null;

interface Kernel32Sync {
  WaitForSingleObject: (handle: unknown, ms: number) => number;
  ReleaseSemaphore: (handle: unknown, releaseCount: number, prevCount: Buffer | null) => number;
}

let _syncFns: Kernel32Sync | null = null;

function loadKernel32(): Kernel32Sync | null {
  if (_syncFns) return _syncFns;
  try {
    _kernel32 = koffi.load("kernel32.dll");
    _syncFns = {
      WaitForSingleObject: _kernel32.func("WaitForSingleObject", "uint32", ["void *", "uint32"]),
      ReleaseSemaphore: _kernel32.func("ReleaseSemaphore", "int32", ["void *", "int32", "void *"]),
    };
    return _syncFns;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GameView
// ---------------------------------------------------------------------------

/**
 * Captures game frames from FxDK's D3D11 shared textures and delivers them
 * as raw BGRA pixel buffers to the Electron renderer.
 *
 * Supports two rendering paths:
 * - **CPU readback** (default): Opens the shared texture, copies to a staging
 *   texture, maps the staging texture, and reads pixels on the CPU side.
 *   Implemented via pure Koffi COM vtable calls (no native addon needed).
 * - **GPU shared texture** (future): Uses Electron's experimental
 *   `sharedTexture` API to import D3D11 textures as VideoFrames.
 */
export class GameView {
  private readonly width: number;
  private readonly height: number;
  private readonly preferGpu: boolean;

  private backend: RenderBackend = "none";
  private running = false;
  private frameCallback: FrameCallback | null = null;

  // D3D11 device used for CPU readback capture
  private captureDevice: D3D11DeviceAndContext | null = null;

  // Capture state
  private surfaceHandles: bigint[] = [];
  private surfaceLimit = 0;
  private consumeIdx = 0;

  // Sync mode: opaque koffi HANDLE pointers for semaphore-based capture
  private syncSurfaceHandles: unknown[] = [];
  private consumeSema: unknown = null;
  private produceSema: unknown = null;
  private syncMode = false;

  // Stats
  private frameCount = 0;
  private droppedFrames = 0;
  private fpsTimestamp = 0;
  private currentFps = 0;

  // Capture loop handle
  private captureTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: GameViewOptions) {
    this.width = options.width;
    this.height = options.height;
    this.preferGpu = options.preferGpu;
  }

  // -------------------------------------------------------------------------
  // Static capability detection
  // -------------------------------------------------------------------------

  /**
   * Detect which rendering backends are available on this machine.
   *
   * - **CPU path**: Requires `d3d11.dll` loadable + device creation.
   * - **GPU path**: Requires Electron >= 40 with `sharedTexture` support
   *   AND a dedicated GPU. Currently always returns `false`.
   */
  static detectCapabilities(): CapabilityReport {
    const reasons: string[] = [];

    // -- CPU path: can we create a D3D11 device? --
    const cpuAvailable = probeD3D11Device();
    if (!cpuAvailable) {
      reasons.push("CPU path unavailable: failed to create D3D11 device");
    }

    // -- GPU path: Electron sharedTexture support --
    // Electron v39 does not expose the sharedTexture API.
    // Even when it does (v40+), FxDK creates legacy DXGI shared handles
    // (DXGIResource::GetSharedHandle) which are incompatible with Electron's
    // NT HANDLE requirement (DXGIResource1::CreateSharedHandle).
    const gpuAvailable = false;
    reasons.push(
      "GPU path unavailable: requires Electron >= 40 with sharedTexture API " +
        "and NT HANDLE support in FxDK (legacy DXGI handles are incompatible)",
    );

    return {
      gpuAvailable,
      cpuAvailable,
      reason: reasons.join("; "),
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Returns the active rendering backend. */
  getBackend(): RenderBackend {
    return this.backend;
  }

  /**
   * Register a callback that receives every captured frame.
   * Only one callback is supported — subsequent calls replace the previous.
   */
  onFrame(callback: FrameCallback): void {
    this.frameCallback = callback;
  }

  /**
   * Begin the frame capture loop.
   *
   * @param surfaceHandles - Array of D3D11 shared texture HANDLEs
   *   (from `ReverseGameData.surfaces`), represented as bigints.
   * @param surfaceLimit - Number of surfaces in the ring buffer
   *   (typically `ReverseGameData.
   */
  start(surfaceHandles: bigint[], surfaceLimit: number): void {
    if (this.running) return;

    this.surfaceHandles = surfaceHandles;
    this.surfaceLimit = surfaceLimit;
    this.consumeIdx = 0;
    this.frameCount = 0;
    this.droppedFrames = 0;
    this.fpsTimestamp = performance.now();
    this.currentFps = 0;

    // Decide backend
    if (this.preferGpu) {
      const caps = GameView.detectCapabilities();
      if (caps.gpuAvailable) {
        this.backend = "gpu";
      } else if (caps.cpuAvailable) {
        this.backend = "cpu";
      } else {
        this.backend = "none";
      }
    } else {
      const caps = GameView.detectCapabilities();
      this.backend = caps.cpuAvailable ? "cpu" : "none";
    }

    if (this.backend === "none") {
      console.warn("[GameView] No rendering backend available — cannot capture frames");
      return;
    }

    if (this.backend === "gpu") {
      // GPU path is a stub for now
      console.warn("[GameView] GPU path selected but not yet implemented — falling back to CPU");
      this.backend = "cpu";
    }

    // Ensure kernel32 sync primitives are loaded
    if (!loadKernel32()) {
      console.error("[GameView] Failed to load kernel32.dll sync primitives");
      this.backend = "none";
      return;
    }

    // Create a persistent D3D11 device for CPU readback capture
    this.captureDevice = createD3D11Device();
    if (!this.captureDevice) {
      console.error("[GameView] Failed to create D3D11 capture device");
      this.backend = "none";
      return;
    }

    this.running = true;
    this.startCaptureLoop();
  }

  /**
   * Begin the frame capture loop using opaque koffi HANDLE pointers
   * and semaphore-based synchronization.
   *
   * This is the "real" capture path used by the FxDK orchestrator.
   * Surface handles are opaque koffi pointers (NOT bigints) — passed
   * directly to captureFrameFromHandle() without conversion.
   *
   * @param surfaceHandles - Array of opaque koffi HANDLE pointers (from ReverseGameData.surfaces)
   * @param surfaceLimit   - Number of surfaces in the ring buffer
   * @param consumeSema    - Opaque koffi HANDLE for the consume semaphore
   * @param produceSema    - Opaque koffi HANDLE for the produce semaphore
   */
  startWithSync(
    surfaceHandles: unknown[],
    surfaceLimit: number,
    consumeSema: unknown,
    produceSema: unknown,
  ): void {
    if (this.running) return;

    this.syncSurfaceHandles = surfaceHandles;
    this.surfaceLimit = surfaceLimit;
    this.consumeSema = consumeSema;
    this.produceSema = produceSema;
    this.syncMode = true;
    this.consumeIdx = 0;
    this.frameCount = 0;
    this.droppedFrames = 0;
    this.fpsTimestamp = performance.now();
    this.currentFps = 0;

    // CPU path only for sync mode
    const caps = GameView.detectCapabilities();
    if (!caps.cpuAvailable) {
      console.warn("[GameView] CPU path unavailable — cannot capture frames");
      this.backend = "none";
      return;
    }
    this.backend = "cpu";

    if (!loadKernel32()) {
      console.error("[GameView] Failed to load kernel32.dll sync primitives");
      this.backend = "none";
      return;
    }

    this.captureDevice = createD3D11Device();
    if (!this.captureDevice) {
      console.error("[GameView] Failed to create D3D11 capture device");
      this.backend = "none";
      return;
    }

    this.running = true;
    this.startCaptureLoop();
  }

  /** Stop the frame capture loop and release resources. */
  stop(): void {
    this.running = false;
    if (this.captureTimer) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }
    // Release the persistent D3D11 capture device
    if (this.captureDevice) {
      releaseComPtr(this.captureDevice.ppDevice);
      releaseComPtr(this.captureDevice.ppContext);
      this.captureDevice = null;
    }
    this.backend = "none";
    this.syncMode = false;
    this.syncSurfaceHandles = [];
    this.consumeSema = null;
    this.produceSema = null;
  }

  /** Returns current capture statistics. */
  getStats(): FrameStats {
    return {
      fps: this.currentFps,
      backend: this.backend,
      droppedFrames: this.droppedFrames,
    };
  }

  // -------------------------------------------------------------------------
  // Frame capture loop (CPU path)
  // -------------------------------------------------------------------------

  private startCaptureLoop(): void {
    this.captureTimer = setInterval(() => {
      if (!this.running) return;
      this.tickCpuCapture();
    }, 1); // Run as fast as the event loop allows; sync is gated by semaphore
  }

  private tickCpuCapture(): void {
    const sync = _syncFns;

    // ------------------------------------------------------------------
    // Step 1: Wait on consumeSema (sync mode only)
    // ------------------------------------------------------------------
    if (this.syncMode && this.consumeSema && sync) {
      const waitResult = sync.WaitForSingleObject(this.consumeSema, SEMA_WAIT_MS);
      if (waitResult === GV_WAIT_TIMEOUT) return; // no frame ready
      if (waitResult === GV_WAIT_FAILED) {
        this.droppedFrames++;
        return;
      }
    }

    // ------------------------------------------------------------------
    // Step 2: Get current surface handle
    // ------------------------------------------------------------------
    const surfaceIdx = this.consumeIdx % this.surfaceLimit;

    if (!this.captureDevice) {
      this.droppedFrames++;
      return;
    }

    let handlePtr: unknown;
    if (this.syncMode) {
      // Sync mode: handles are already opaque koffi pointers
      handlePtr = this.syncSurfaceHandles[surfaceIdx];
    } else {
      // Legacy mode: handles are bigints, convert to koffi pointer
      const surfaceHandle = this.surfaceHandles[surfaceIdx];
      const handleBuf = Buffer.alloc(8);
      handleBuf.writeBigUInt64LE(surfaceHandle);
      handlePtr = koffi.decode(handleBuf, "void *");
    }

    // ------------------------------------------------------------------
    // Step 3: D3D11 readback via captureFrameFromHandle
    // ------------------------------------------------------------------
    const pixelBuffer = captureFrameFromHandle(
      this.captureDevice,
      handlePtr,
      this.width,
      this.height,
    );

    if (!pixelBuffer) {
      this.droppedFrames++;
      return;
    }

    // ------------------------------------------------------------------
    // Step 4: Deliver frame to callback
    // ------------------------------------------------------------------
    if (this.frameCallback) {
      const frame: FrameData = {
        buffer: pixelBuffer,
        width: this.width,
        height: this.height,
        timestamp: performance.now(),
      };
      this.frameCallback(frame);
    }

    // ------------------------------------------------------------------
    // Step 5: Advance index and release produceSema
    // ------------------------------------------------------------------
    this.consumeIdx = (this.consumeIdx + 1) % this.surfaceLimit;

    if (this.syncMode && this.produceSema && sync) {
      sync.ReleaseSemaphore(this.produceSema, 1, null);
    }

    // ------------------------------------------------------------------
    // Step 6: Update FPS counter
    // ------------------------------------------------------------------
    this.frameCount++;
    const now = performance.now();
    const elapsed = now - this.fpsTimestamp;
    if (elapsed >= 1000) {
      this.currentFps = Math.round((this.frameCount / elapsed) * 1000);
      this.frameCount = 0;
      this.fpsTimestamp = now;
    }
  }
}
