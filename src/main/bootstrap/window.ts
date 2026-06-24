/**
 * Window bootstrap — main BrowserWindow creation + navigation guard.
 *
 * Behavior-preserving extraction from src/main/index.ts. createWindow() builds
 * the single main window exactly as before; registerNavigationGuard() installs
 * the web-contents-created navigation blocker. The dev-bypass flag is passed in
 * (it remains a Vite build-time literal owned by index.ts).
 */

import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import { app, BrowserWindow, Menu, shell } from "electron";
import log from "electron-log/main";
import icon from "../../../resources/icon.png?asset";
import { state } from "../shared-state";

/**
 * Security: restrict in-app navigation (Electron checklist #13, fivem-studio-o6r).
 * The renderer only loads our own UI (dev server in dev, file:// in prod), so any
 * top-level navigation elsewhere is unexpected — block it, and open real http(s)
 * links in the user's browser instead. (Subframes are governed by the CSP and new
 * windows by setWindowOpenHandler.)
 */
export function registerNavigationGuard(): void {
  app.on("web-contents-created", (_event, contents) => {
    const isInternal = (target: string): boolean => {
      try {
        const u = new URL(target);
        if (u.protocol === "file:" || u.protocol === "about:" || u.protocol === "devtools:")
          return true;
        if (is.dev && process.env.ELECTRON_RENDERER_URL)
          return u.host === new URL(process.env.ELECTRON_RENDERER_URL).host;
        return false;
      } catch {
        return false;
      }
    };
    // The renderer only ever loads our own UI. Discord sign-in happens entirely in
    // the user's system browser (auth:start-signin loopback + shell.openExternal),
    // so no Electron window should navigate to Supabase/Discord. Any external
    // top-level navigation is unexpected — block it and open genuine http(s) links
    // in the system browser instead.
    const blockExternalNav = (event: Electron.Event, target: string): void => {
      if (isInternal(target)) return;
      event.preventDefault();
      log.warn(
        "[security] blocked navigation to",
        target,
        "from webContents",
        contents.id,
        contents.getURL(),
      );
      if (target.startsWith("http")) void shell.openExternal(target);
    };
    contents.on("will-navigate", (e, target) => blockExternalNav(e, target));
    contents.on("will-redirect", (e, target) => blockExternalNav(e, target));
  });
}

/**
 * Create the single main BrowserWindow and load the renderer. `devBypass`
 * exposes the dev-bypass flag to the preload synchronously (fivem-studio-lwt).
 */
export function createWindow(devBypass: boolean): void {
  // Custom-UI app — skip Electron's default application menu entirely. Avoids
  // building the native File/Edit/View/Window/Help menu (Electron perf checklist
  // item 8) and removes the menu bar in production. Standard edit shortcuts
  // (copy/paste/select-all) still work in inputs — Chromium handles those itself.
  Menu.setApplicationMenu(null);

  state.mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#09090b",
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      // Expose the dev-bypass flag to the preload synchronously (lwt).
      additionalArguments: [`--fivem-dev-bypass=${devBypass ? "1" : "0"}`],
      // Sandbox ON (Electron security checklist #4). Root cause of the earlier
      // breakage: the preload did `require('@electron-toolkit/preload')`, which a
      // sandboxed preload can't do (only `require('electron')` + polyfilled
      // builtins are allowed) — so the preload aborted and window.api never
      // exposed. Fixed by dropping that unused dep (it only powered an unused
      // window.electron). Preload now requires only 'electron'. (fivem-studio-c0x)
      sandbox: true,
    },
  });

  // Open maximized — fill the screen instead of the small 900x670 default.
  state.mainWindow.on("ready-to-show", () => {
    state.mainWindow?.maximize();
    state.mainWindow?.show();
  });

  // Allow microphone access for Web Speech API
  state.mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media");
  });
  state.mainWindow.webContents.session.setPermissionCheckHandler(
    (_wc, permission) => permission === "media",
  );

  // All window.open from the renderer (Stripe checkout/portal, external links) →
  // system browser. Discord sign-in does NOT use window.open — the renderer opens
  // the Supabase authorize URL via the shell:openExternal IPC, and the OAuth code
  // returns to the main-process loopback (auth:start-signin).
  state.mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    // Dev-only: mirror the renderer console (incl. React/Clerk errors) into the
    // main process stdout so renderer failures are visible in the terminal, and
    // open DevTools. Both are stripped from packaged builds (is.dev === false).
    state.mainWindow.webContents.openDevTools({ mode: "detach" });
    state.mainWindow.webContents.on(
      "console-message",
      (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
        console.log(
          `[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`,
        );
      },
    );
    state.mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    state.mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}
