/**
 * IPC handlers for FxDK: server start/stop, process check, RCON,
 * session state, console, orchestrator, and gameview.
 */

import { access } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { app, ipcMain } from "electron";
import log from "electron-log/main";
import { getActiveServer } from "../../renderer/src/lib/server-registry";
import { sendRconCommand } from "../auto-deploy";
import { resolveServerRconPassword } from "../context";
import type { OrchestratorConfig } from "../fxdk/fxdk-orchestrator";
import { checkFxServerProcess, startFxServer, stopFxServer } from "../server-control";
import { fxdkSession, gameViewManager, orchestrator, readSettings, state } from "../shared-state";
import { deployAndVerifyAll, deployAndVerifyResource } from "../smoke-test";

export function registerFxdkHandlers(): void {
  // Server status — ping /info.json (no auth required)
  ipcMain.handle(
    "server:ping",
    (_event, port: number): Promise<{ online: boolean; hostname?: string }> => {
      return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/info.json`, { timeout: 2000 }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              const json = JSON.parse(body) as {
                vars?: { sv_hostname?: string };
              };
              resolve({
                online: true,
                hostname: json.vars?.sv_hostname ?? undefined,
              });
            } catch {
              resolve({ online: true });
            }
          });
        });
        req.on("error", () => resolve({ online: false }));
        req.on("timeout", () => {
          req.destroy();
          resolve({ online: false });
        });
      });
    },
  );

  // Server RCON restart
  ipcMain.handle(
    "server:restart",
    (_event, resourceName: string, port: number, rconPassword: string) =>
      sendRconCommand(port, rconPassword, `restart ${resourceName}`),
  );

  // Deploy & smoke-test: ensure the resource, then scan the server console for
  // load errors (Lua/deps/parse) → structured pass/fail. Reads port/rcon from
  // settings so the caller only passes the resource name.
  ipcMain.handle("server:smokeTest", async (_event, resourceName: string) => {
    const server = getActiveServer(await readSettings());
    if (!server) {
      return {
        ok: false,
        deployed: false,
        loadSuccess: false,
        startedConfirmed: false,
        loadError: "No settings found — configure the server path + RCON password.",
        secondsWaited: 0,
      };
    }
    return deployAndVerifyResource(
      resourceName,
      server.serverPort ?? 30120,
      await resolveServerRconPassword(server, state.cachedContext?.serverCfgPath),
    );
  });

  // Full deploy & smoke-test: ensure EVERY built resource and scan once for load
  // errors → per-resource pass/fail. The caller passes the resource list (it has
  // it from the file tree); port/rcon come from the active server.
  ipcMain.handle("server:smokeTestAll", async (_event, resourceNames: string[]) => {
    const server = getActiveServer(await readSettings());
    if (!server) {
      return {
        ok: false,
        results: (resourceNames ?? []).map((resource) => ({
          resource,
          ok: false,
          deployed: false,
          loadSuccess: false,
          startedConfirmed: false,
          loadError: "No settings found — configure the server path + RCON password.",
          secondsWaited: 0,
        })),
      };
    }
    return deployAndVerifyAll(
      resourceNames ?? [],
      server.serverPort ?? 30120,
      await resolveServerRconPassword(server, state.cachedContext?.serverCfgPath),
    );
  });

  // Check if FXServer.exe is running on Windows
  ipcMain.handle("server:checkProcess", () => checkFxServerProcess());

  // Start FXServer via FxDkSession (shared with the agent's start_server tool)
  ipcMain.handle("server:start", () => startFxServer());

  // Stop FXServer — session child first, fall back to taskkill (shared with stop_server)
  ipcMain.handle("server:stop", () => stopFxServer());

  // FxDK session state / console
  ipcMain.handle("fxdk:getSessionState", () => fxdkSession.state);
  ipcMain.handle("fxdk:getConsoleBuffer", () => fxdkSession.getConsoleBuffer());

  // Test RCON connection
  ipcMain.handle("server:testRcon", (_event, port: number, rconPassword: string) =>
    sendRconCommand(port, rconPassword, "status"),
  );

  // GameView — frame capture
  ipcMain.handle("gameview:start", (_event, options) => gameViewManager.start(options));
  ipcMain.handle("gameview:stop", () => gameViewManager.stop());
  ipcMain.handle("gameview:stats", () => gameViewManager.getStats());
  ipcMain.handle("gameview:capabilities", () => gameViewManager.getCapabilities());

  // Orchestrator — FxDK game client lifecycle
  ipcMain.handle("orchestrator:startGame", async (_event, config: OrchestratorConfig) => {
    log.info(`[orchestrator] IPC startGame called, fivemExePath="${config.fivemExePath ?? ""}"`);
    if (!config.fivemExePath) {
      const localAppData =
        process.env.LOCALAPPDATA ?? app.getPath("appData").replace(/[/\\]Roaming$/i, "\\Local");
      const gtaProcessPath = join(
        localAppData,
        "FiveM",
        "FiveM.app",
        "data",
        "cache",
        "subprocess",
        "FiveM_GTAProcess.exe",
      );
      log.info(`[orchestrator] Checking FiveM_GTAProcess path: ${gtaProcessPath}`);
      try {
        await access(gtaProcessPath);
        config.fivemExePath = gtaProcessPath;
        log.info(`[orchestrator] Found game process at: ${gtaProcessPath}`);
      } catch {
        const server = getActiveServer(await readSettings());
        if (server?.fivemExePath) {
          config.fivemExePath = server.fivemExePath;
        }
      }
      if (!config.fivemExePath) {
        return {
          ok: false,
          error:
            "FiveM_GTAProcess.exe not found. Ensure FiveM is installed and has been launched at least once.",
        };
      }
    }
    return orchestrator.startGame(config);
  });
  ipcMain.handle("orchestrator:stopGame", () => orchestrator.stopGame());
  ipcMain.handle("orchestrator:getState", () => orchestrator.state);
}
