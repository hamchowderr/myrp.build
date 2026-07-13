/**
 * Electron main process entry point.
 * App lifecycle only — IPC handlers are registered in src/main/ipc/*.
 */

import { existsSync } from "node:fs";
import path, { join } from "node:path";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import dotenv from "dotenv";
import { app, BrowserWindow, protocol } from "electron";
import log from "electron-log/main";
import { autoUpdater } from "electron-updater";
import { registerAuthHandlers } from "./bootstrap/auth";
import { seedFastembedModel } from "./bootstrap/fastembed-seed";
import { wireRuntimeEvents } from "./bootstrap/runtime-wiring";
import { createWindow, registerNavigationGuard } from "./bootstrap/window";
import { registerBackupHandlers } from "./ipc/backup";
import { registerChatHandlers } from "./ipc/chat";
import { registerContextHandlers } from "./ipc/context";
import { registerFileHandlers } from "./ipc/files";
import { registerFxdkHandlers } from "./ipc/fxdk";
import { registerSettingsHandlers } from "./ipc/settings";
import { registerThreadHandlers } from "./ipc/threads";
import { registerTxAdminHandlers } from "./ipc/txadmin";
import { registerVoiceHandlers } from "./ipc/voice";
import { setLogger } from "./mastra/log";
import { initCrashReporter } from "./native-features";
import {
  fxdkSession,
  gameViewManager,
  orchestrator,
  sendStreamMessage,
  state,
} from "./shared-state";

// Load .env in dev ONLY. Packaged builds must not read a local .env from the
// user's CWD — (a) a user could plant a FIVEM_STUDIO_DEV=1 next to the .exe and
// trip the runtime-assert below, (b) it's a generic env-injection vector. All
// values the shipped binary needs come from Vite's build-time `define`
// (electron.vite.config.ts) — see PROXY_BASE_URL, VITE_SUPABASE_ANON_KEY, etc.
if (!app.isPackaged) {
  dotenv.config();
}

// Dev-mode bypass: renderer skips the Discord sign-in + Supabase
// usage path and runs on a direct ANTHROPIC_API_KEY when this is true.
//
// __DEV_BYPASS__ is a Vite-injected build-time literal (electron.vite.config.ts).
// It is `true` ONLY when `electron-vite dev|preview` is running AND .env sets
// FIVEM_STUDIO_DEV=1. In every packaged build it is the literal `false`, so the
// minifier removes the bypass branch entirely — the env-var read and the dev
// account path are not in the shipped bundle. Verify with:
//   grep DEV_BYPASS out/main/index.js   (should not appear in packaged output)
//
// ANTHROPIC_API_KEY is intentionally NOT a trigger anymore (common dev env var
// unrelated to intent — earlier hardening pass made it leak owner-bypass into
// the installed exe).
const DEV_BYPASS = __DEV_BYPASS__;

// Belt-and-braces (defense-in-depth): a packaged build must NEVER honor a dev
// bypass flag regardless of how it was set — env var, CLI argv, or an asar
// repack injecting additionalArguments. The server-side proxy would reject the
// resulting requests anyway (a valid session JWT is required), so failing fast on launch is
// cleaner than half-mounting the UI with bad assumptions.
if (app.isPackaged) {
  const tampered =
    !!process.env.FIVEM_STUDIO_DEV || process.argv.some((a) => a.startsWith("--fivem-dev-bypass"));
  if (tampered) {
    log.error("[security] packaged build refusing to start with dev bypass flag present");
    app.quit();
    process.exit(1);
  }

  // Point the in-generation Lua syntax validator at the bundled
  // luacheck. In dev it resolves on PATH; a packaged build ships
  // resources/bin/luacheck.exe asar-UNPACKED (electron-builder.yml), and a spawn can
  // only exec a real file on disk — so use the unpacked copy. Falls back gracefully
  // (validator skips luacheck, keeps its pure-JS checks) if the binary is missing.
  const bundledLuacheck = join(
    process.resourcesPath,
    "app.asar.unpacked",
    "resources",
    "bin",
    "luacheck.exe",
  );
  if (existsSync(bundledLuacheck)) process.env.LUACHECK_PATH = bundledLuacheck;
}

// Resolve bundled lua-language-server and expose it via LUALS_PATH for the
// Workspace LSP (mastra/workspace.ts) and the validator's `--check` gate
// (mastra/tools/validator.ts). Packaged builds carry it as an extraResource under
// <resources>/lua-language-server; dev uses the copy the prefetch script vendors under
// <repo>/build/lua-language-server. Runs in BOTH modes (unlike luacheck, which resolves
// on PATH in dev). Both consumers skip Lua LSP gracefully when it's unresolved.
const lualsExe = process.platform === "win32" ? "lua-language-server.exe" : "lua-language-server";
const lualsBin = [
  process.env.LUALS_PATH,
  join(process.resourcesPath, "lua-language-server", "bin", lualsExe),
  join(app.getAppPath(), "build", "lua-language-server", "bin", lualsExe),
].find((p) => p && existsSync(p));
if (lualsBin) process.env.LUALS_PATH = lualsBin;

// Dev-only: expose the renderer over the Chrome DevTools Protocol so a Playwright
// harness can attach to the running, signed-in app (chromium.connectOverCDP).
// Must be set before app `ready` (Chromium reads switches at startup). No effect
// in packaged builds. Electron docs: --remote-debugging-port.
if (is.dev) {
  app.commandLine.appendSwitch("remote-debugging-port", "9222");
}

log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.console.level = "info";
log.errorHandler.startCatching();

// Route the agent's/tools' logs (src/main/mastra/** → ./mastra/log) to electron-log
// so the packaged app keeps file logging. Outside Electron (Studio/tests) those
// modules default to console — see src/main/mastra/log.ts.
setLogger(log);

// Crash reporting for the native-heavy surface (D3D11 capture / koffi FFI /
// FXServer child). Start before app `ready` so early crashes are captured.
initCrashReporter();

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection:", reason);
  sendStreamMessage({
    type: "error",
    text: `Unexpected error: ${reason instanceof Error ? reason.message : String(reason)}`,
  });
});

// Single-instance lock: a second instance would fight over the
// resources/ folder, the FXServer, DB connections, and ports. Enforce only in
// packaged builds — electron-vite's dev hot-reload restarts the main process, and
// a lock would make the relaunched instance quit (looks like "won't start").
const gotSingleInstanceLock = !app.isPackaged || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// Custom protocol scheme myrpbuild://. Supabase Auth rejects file://
// in redirect_url server-side, so OAuth + email sign-up callbacks come back via
// this scheme. registerSchemesAsPrivileged MUST run before app.whenReady so the
// scheme has standard/secure/fetch privileges when the URL arrives.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "myrpbuild",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

// Register this binary as the OS handler for myrpbuild://. In a packaged build
// the installer already wrote the registry entries (electron-builder protocols),
// but this call is still needed so the running process is the active handler.
// In dev (`electron .`), pass the script path so Windows knows what to relaunch.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient("myrpbuild", process.execPath, [
    path.resolve(process.argv[1] ?? ""),
  ]);
} else {
  app.setAsDefaultProtocolClient("myrpbuild");
}

// Discord sign-in loopback + encrypted auth store. Registered
// at module load — same point as before — so the IPC handlers are ready as soon
// as the renderer mounts. See src/main/bootstrap/auth.ts for the full rationale.
registerAuthHandlers();

// Security: restrict in-app navigation (Electron checklist #13).
// See src/main/bootstrap/window.ts. Registered at module load to match prior
// ordering (after the auth handlers, before any window is created).
registerNavigationGuard();

// --- App Lifecycle ---

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return; // a primary instance already owns the app
  log.info("App starting, version:", app.getVersion());
  electronApp.setAppUserModelId("com.otakusolutions.myrp-build");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Focus the existing window when a second launch is attempted.
  app.on("second-instance", () => {
    const w = state.mainWindow;
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  // Auto-update: check + notify on launch. Packaged only —
  // no-ops in dev, and requires signed releases published to the configured
  // GitHub provider (so this fully activates after code-signing lands, wew).
  //
  // Only runs when app-update.yml is present alongside the binary — `npm run
  // build:unpack:nosign` skips installer artifacts so the file is absent there,
  // and calling the updater would throw ENOENT and surface as an unhandled
  // rejection (interferes with Playwright's launch handshake).
  if (app.isPackaged) {
    const updateConfigPath = join(process.resourcesPath, "app-update.yml");
    if (existsSync(updateConfigPath)) {
      autoUpdater.logger = log;
      autoUpdater.on("error", (err) => log.error("[updater]", err));
      autoUpdater.on("update-downloaded", (info) =>
        log.info("[updater] update downloaded:", info.version),
      );
      autoUpdater
        .checkForUpdatesAndNotify()
        .catch((err) => log.error("[updater] check failed:", err));
    } else {
      log.info("[updater] app-update.yml missing — skipping update check (unpacked test build).");
    }
  }

  // Seed the bundled fastembed bge-small weights into the model cache before any
  // IPC handler can trigger an embedding. No-op in dev / when already cached.
  seedFastembedModel();

  // Register all IPC handler groups
  registerSettingsHandlers();
  registerChatHandlers();
  registerThreadHandlers();
  registerFileHandlers();
  registerFxdkHandlers();
  registerContextHandlers();
  registerVoiceHandlers();
  registerTxAdminHandlers();
  registerBackupHandlers();

  createWindow(DEV_BYPASS);
  gameViewManager.setWindow(state.mainWindow!);

  // Generation runs on the embedded Mastra agent via ipc/chat.ts (AI SDK v6
  // UIMessage stream). The Agent-SDK worker, QMD, MCP, and batch paths are gone.

  // Wire orchestrator (game view) + FxDK session events to the renderer and the
  // powerSaveBlocker / notification side-effects. See bootstrap/runtime-wiring.ts.
  wireRuntimeEvents();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(DEV_BYPASS);
  });

  app.on("before-quit", () => {
    orchestrator.destroy();
    fxdkSession.destroy();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
