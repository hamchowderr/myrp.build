/**
 * IPC handlers for settings save/load and folder/file dialogs.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { app, dialog, ipcMain } from "electron";
import type { AppSettings } from "../../renderer/src/lib/types";
import { type ScaffoldResult, scaffoldServer } from "../scaffold";
import { getSettingsPath, readSettings } from "../shared-state";

export function registerSettingsHandlers(): void {
  ipcMain.handle("dialog:selectFolder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle("dialog:selectFile", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Executables", extensions: ["exe"] }],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle("settings:save", async (_event, settings: AppSettings) => {
    await mkdir(app.getPath("userData"), { recursive: true });
    await writeFile(getSettingsPath(), JSON.stringify(settings, null, 2), "utf-8");
  });

  ipcMain.handle("settings:load", async () => {
    const settings = await readSettings();
    // First run (no servers registered yet) → null so the renderer shows Setup.
    return settings.servers.length > 0 ? settings : null;
  });

  // Scaffold a fresh ox server folder (m8se.4). Returns the new paths + which ox
  // base resources downloaded, or an error string the renderer can surface.
  ipcMain.handle(
    "servers:scaffold",
    async (
      _event,
      parentDir: string,
      name: string,
    ): Promise<ScaffoldResult | { error: string }> => {
      try {
        return await scaffoldServer(parentDir, name);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}
