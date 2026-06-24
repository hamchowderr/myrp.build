import type { BrowserWindow } from "electron";
import { nativeImage } from "electron";
import type {
  GameFrameMessage,
  GameViewCapabilities,
  GameViewStartOptions,
  GameViewStats,
} from "../../renderer/src/lib/types";
import { GameView } from "./game-view";

export class GameViewManager {
  private window: BrowserWindow | null = null;
  private gameView: GameView | null = null;
  private testTimer: ReturnType<typeof setInterval> | null = null;
  private targetFps = 10;
  private lastSendTime = 0;

  // Stats
  private currentFps = 0;
  private frameCount = 0;
  private fpsTimestamp = 0;
  private droppedFrames = 0;
  private activeBackend: GameFrameMessage["backend"] = "none";

  // Test mode animation state
  private testFrameIndex = 0;

  setWindow(win: BrowserWindow): void {
    this.window = win;
  }

  start(options?: GameViewStartOptions): { ok: boolean; error?: string } {
    if (this.testTimer || this.gameView) {
      return { ok: false, error: "Already capturing" };
    }

    const width = options?.width ?? 1280;
    const height = options?.height ?? 720;
    this.targetFps = options?.targetFps ?? 10;
    this.frameCount = 0;
    this.fpsTimestamp = performance.now();
    this.currentFps = 0;
    this.droppedFrames = 0;
    this.lastSendTime = 0;

    if (options?.testMode) {
      return this.startTestMode(width, height);
    }

    return this.startRealCapture(width, height);
  }

  stop(): void {
    if (this.testTimer) {
      clearInterval(this.testTimer);
      this.testTimer = null;
    }
    if (this.gameView) {
      this.gameView.stop();
      this.gameView = null;
    }
    this.activeBackend = "none";
    this.currentFps = 0;
  }

  getStats(): GameViewStats {
    return {
      fps: this.currentFps,
      backend: this.activeBackend,
      droppedFrames: this.droppedFrames,
    };
  }

  getCapabilities(): GameViewCapabilities {
    try {
      const caps = GameView.detectCapabilities();
      return {
        gpuAvailable: caps.gpuAvailable,
        cpuAvailable: caps.cpuAvailable,
        reason: caps.reason,
      };
    } catch {
      return {
        gpuAvailable: false,
        cpuAvailable: false,
        reason: "Failed to detect capabilities",
      };
    }
  }

  private startTestMode(width: number, height: number): { ok: boolean; error?: string } {
    this.activeBackend = "test";
    this.testFrameIndex = 0;

    const intervalMs = Math.round(1000 / this.targetFps);

    this.testTimer = setInterval(() => {
      const now = performance.now();
      const minInterval = 1000 / (this.targetFps + 2);
      if (now - this.lastSendTime < minInterval) return;

      const buffer = this.generateTestFrame(width, height);
      this.sendFrame(buffer, width, height);
      this.testFrameIndex++;
    }, intervalMs);

    return { ok: true };
  }

  /**
   * Start frame capture using pre-resolved surface handles and semaphores
   * from the FxDK orchestrator. This is the "real" capture path for live
   * game frames.
   *
   * @param surfaceHandles - Opaque koffi HANDLE pointers to DXGI shared textures
   * @param consumeSema    - Opaque koffi HANDLE for consume semaphore
   * @param produceSema    - Opaque koffi HANDLE for produce semaphore
   * @param surfaceLimit   - Number of surfaces in the ring buffer
   * @param width          - Render width in pixels
   * @param height         - Render height in pixels
   */
  startWithHandles(
    surfaceHandles: unknown[],
    consumeSema: unknown,
    produceSema: unknown,
    surfaceLimit: number,
    width: number,
    height: number,
  ): { ok: boolean; error?: string } {
    if (this.testTimer || this.gameView) {
      return { ok: false, error: "Already capturing" };
    }

    this.frameCount = 0;
    this.fpsTimestamp = performance.now();
    this.currentFps = 0;
    this.droppedFrames = 0;
    this.lastSendTime = 0;
    this.targetFps = 30; // Higher FPS for real capture

    this.gameView = new GameView({ width, height, preferGpu: false });
    this.activeBackend = "cpu";

    this.gameView.onFrame((frame) => {
      const now = performance.now();
      const minInterval = 1000 / (this.targetFps + 2);
      if (now - this.lastSendTime < minInterval) {
        this.droppedFrames++;
        return;
      }
      this.sendFrame(frame.buffer, frame.width, frame.height);
    });

    this.gameView.startWithSync(surfaceHandles, surfaceLimit, consumeSema, produceSema);

    if (this.gameView.getBackend() === "none") {
      this.gameView = null;
      this.activeBackend = "none";
      return { ok: false, error: "Failed to initialize capture backend" };
    }

    return { ok: true };
  }

  private startRealCapture(width: number, height: number): { ok: boolean; error?: string } {
    const caps = GameView.detectCapabilities();
    if (!caps.cpuAvailable && !caps.gpuAvailable) {
      return {
        ok: false,
        error: `No capture backend available: ${caps.reason}`,
      };
    }

    this.gameView = new GameView({ width, height, preferGpu: false });
    this.activeBackend = "cpu";

    this.gameView.onFrame((frame) => {
      const now = performance.now();
      const minInterval = 1000 / (this.targetFps + 2);
      if (now - this.lastSendTime < minInterval) {
        this.droppedFrames++;
        return;
      }
      this.sendFrame(frame.buffer, frame.width, frame.height);
    });

    // Real capture needs shared texture handles from FxDK session.
    // Without them, we can't start — return an error guiding the user.
    return {
      ok: false,
      error:
        "Real capture requires an active FxDK session with shared texture handles. Use Test Mode to verify the pipeline.",
    };
  }

  private sendFrame(bgra: Buffer, width: number, height: number): void {
    if (!this.window || this.window.isDestroyed()) return;

    try {
      const img = nativeImage.createFromBitmap(bgra, { width, height });
      const jpegBuf = img.toJPEG(70);
      const jpeg64 = jpegBuf.toString("base64");

      const msg: GameFrameMessage = {
        jpeg: jpeg64,
        width,
        height,
        timestamp: performance.now(),
        fps: this.currentFps,
        backend: this.activeBackend,
      };

      this.window.webContents.send("stream:gameFrame", msg);
      this.lastSendTime = performance.now();

      // Update FPS counter
      this.frameCount++;
      const elapsed = performance.now() - this.fpsTimestamp;
      if (elapsed >= 1000) {
        this.currentFps = Math.round((this.frameCount / elapsed) * 1000);
        this.frameCount = 0;
        this.fpsTimestamp = performance.now();
      }
    } catch {
      this.droppedFrames++;
    }
  }

  /**
   * Generate a synthetic BGRA test frame with animated gradient.
   * Each frame shifts the hue so the user sees visible motion.
   */
  private generateTestFrame(width: number, height: number): Buffer {
    const buf = Buffer.alloc(width * height * 4);
    const t = this.testFrameIndex;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        // Animated gradient: R shifts with x+t, G shifts with y+t, B is inverse
        buf[offset] = ((x + t * 3) * 0.5) & 0xff; // B
        buf[offset + 1] = ((y + t * 2) * 0.7) & 0xff; // G
        buf[offset + 2] = ((x + y + t * 5) * 0.3) & 0xff; // R
        buf[offset + 3] = 0xff; // A
      }
    }

    return buf;
  }
}
