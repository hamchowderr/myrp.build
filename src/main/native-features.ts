/**
 * Native desktop features (fivem-studio-06k / -1gi / -wty).
 *
 *  - crashReporter   — collect local minidumps for the crash-prone native surface
 *                      (D3D11 frame-capture, shared memory, koffi FFI, FXServer
 *                      child process). Pairs with the hardened electronFuses set
 *                      in electron-builder.yml.
 *  - powerSaveBlocker — keep the machine from suspending during a generation and
 *                      while the FXServer / embedded game-view is active.
 *                      Refcounted: overlapping holders (generation + server +
 *                      game-view) share ONE blocker; released on the last hold.
 *  - Notification    — OS toasts for async generate / server events.
 */

import { app, BrowserWindow, crashReporter, Notification, powerSaveBlocker } from "electron";
import log from "electron-log/main";

/**
 * Start the crash reporter as early as possible (before app `ready`). Dumps are
 * kept local (uploadToServer:false) until a crash-ingest endpoint exists — flip
 * uploadToServer:true + submitURL once a collector (e.g. Sentry/self-host) is up.
 */
export function initCrashReporter(): void {
  try {
    crashReporter.start({
      productName: "myRP.build",
      companyName: "Otaku Solutions",
      uploadToServer: false,
      compress: true,
    });
    log.info("[native] crashReporter started — minidumps at", app.getPath("crashDumps"));
  } catch (err) {
    log.error("[native] crashReporter failed to start:", err);
  }
}

// Refcounted powerSaveBlocker. 'prevent-app-suspension' stops the SYSTEM from
// sleeping (so a long generation or a running server isn't interrupted) without
// forcing the display to stay on.
let blockerId: number | null = null;
let holds = 0;

export function keepAwake(reason: string): () => void {
  holds += 1;
  if (blockerId === null) {
    blockerId = powerSaveBlocker.start("prevent-app-suspension");
    log.info(`[native] powerSaveBlocker ON (${reason})`);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    if (holds === 0 && blockerId !== null) {
      if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
      blockerId = null;
      log.info(`[native] powerSaveBlocker OFF (last hold released: ${reason})`);
    }
  };
}

/**
 * Show an OS notification. With `onlyWhenUnfocused` we skip the toast if a window
 * is focused — the user is already looking at the app, so the toast is just noise
 * (used for generation-complete; server start/stop always notify).
 */
export function notify(title: string, body: string, opts?: { onlyWhenUnfocused?: boolean }): void {
  try {
    if (!Notification.isSupported()) {
      log.warn(`[native] notify skipped — Notification.isSupported()=false (${title})`);
      return;
    }
    if (opts?.onlyWhenUnfocused && BrowserWindow.getAllWindows().some((w) => w.isFocused())) return;
    const n = new Notification({ title, body, silent: false });
    // A Windows toast can be refused AFTER show() by OS settings (Do Not Disturb
    // / Focus Assist, or per-app / global notifications turned off). That only
    // surfaces on the async 'failed' event (HRESULT 0x803E0204), never as a
    // throw — log it so a missing toast is diagnosable from main.log instead of
    // vanishing silently. (fivem-studio-wty)
    n.on("failed", (_e, err) =>
      log.warn(`[native] notification refused by OS settings (${title}): ${err}`),
    );
    n.show();
  } catch (err) {
    log.warn("[native] notification failed:", err);
  }
}
