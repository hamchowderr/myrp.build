/**
 * IPC handlers for server context detection (framework/db/inventory).
 */

import { ipcMain } from "electron";
import { getActiveServer } from "../../renderer/src/lib/server-registry";
import { detectServerContext, findServerExePath, findServerPaths } from "../context";
import { writeServerClaudeMd } from "../fileWriter";
import { readSettings, state } from "../shared-state";

export function registerContextHandlers(): void {
  ipcMain.handle("context:findServers", async () => findServerPaths());

  ipcMain.handle("context:findServerExe", async (_event, serverPath: string) =>
    findServerExePath(serverPath),
  );

  ipcMain.handle("context:detect", async (_event, serverPath: string) => {
    // Prefer the exe path of the registered record for this folder; fall back to
    // the active server's. Non-critical — detection still works without it.
    const settings = await readSettings();
    const record =
      settings.servers.find((s) => s.serverPath === serverPath) ?? getActiveServer(settings);
    const context = await detectServerContext(serverPath, record?.serverExePath ?? undefined);
    state.cachedContext = context;
    writeServerClaudeMd(serverPath, context).catch(() => {});
    return context;
  });
}
