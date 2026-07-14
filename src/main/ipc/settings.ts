/**
 * IPC handlers for settings save/load and folder/file dialogs.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

  // Scaffold a fresh ox server folder. Returns the new paths + which ox
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

  // Default parent folder for a NEW server: the directory that already holds the
  // user's servers (the active one, else the first registered) so new servers
  // ALWAYS land alongside the existing ones — never elsewhere. The Create-new
  // dialog pre-fills this so you only type a name (Browse still overrides).
  // Returns null only on first run (no server registered yet) → the dialog keeps
  // requiring a Browse in that one case.
  ipcMain.handle("servers:defaultParentDir", async (): Promise<string | null> => {
    const settings = await readSettings();
    const active =
      settings.servers.find((s) => s.id === settings.activeServerId) ?? settings.servers[0];
    return active ? dirname(active.serverPath) : null;
  });
}
