/**
 * IPC handlers for file operations: read, write, undo, list, delete, explore.
 */

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ipcMain, shell } from "electron";
import log from "electron-log/main";
import {
  appendEnsureLine,
  isEnsured,
  listGenerationManifests,
  removeEnsureLine,
  undoGeneration,
} from "../fileWriter";
import { state } from "../shared-state";

export function registerFileHandlers(): void {
  // Read a file for the in-app code viewer
  ipcMain.handle("files:read", async (_event, filePath: string) => {
    return await readFile(filePath, "utf-8");
  });

  // Write a file from the in-app code editor
  ipcMain.handle("files:write", async (_event, filePath: string, content: string) => {
    await writeFile(filePath, content, "utf-8");
  });

  // Undo: delete files listed in the manifest
  ipcMain.handle("files:undo", async (_event, manifestPath: string) => {
    await undoGeneration(manifestPath);
  });

  ipcMain.handle("files:listManifests", async (_event, localPath: string) =>
    listGenerationManifests(localPath),
  );

  ipcMain.handle("files:addEnsure", async (_event, resourceName: string) => {
    if (!state.cachedContext?.serverCfgPath) return;
    await appendEnsureLine(state.cachedContext.serverCfgPath, resourceName);
  });

  ipcMain.handle("files:removeEnsure", async (_event, resourceName: string) => {
    if (!state.cachedContext?.serverCfgPath) return;
    await removeEnsureLine(state.cachedContext.serverCfgPath, resourceName);
  });

  ipcMain.handle("files:isEnsured", async (_event, resourceName: string): Promise<boolean> => {
    if (!state.cachedContext?.serverCfgPath) return false;
    return isEnsured(state.cachedContext.serverCfgPath, resourceName);
  });

  // List resource folder names in a given localPath
  ipcMain.handle("files:listResources", async (_event, localPath: string) => {
    try {
      const entries = await readdir(localPath, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  });

  // Delete a resource folder inside localPath
  ipcMain.handle(
    "files:deleteResource",
    async (_event, localPath: string, resourceName: string) => {
      const target = resolve(join(localPath, resourceName));
      // Safety: ensure target is inside localPath
      const rel = relative(localPath, target);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error("Cannot delete resource outside localPath");
      }
      await rm(target, { recursive: true, force: true });
      log.info(`[files] Deleted resource: ${target}`);
    },
  );

  // Recursively list all files in a directory (max depth 5)
  ipcMain.handle("files:listDir", async (_event, dirPath: string) => {
    type FileEntry = {
      name: string;
      relativePath: string;
      absolutePath: string;
    };

    async function walkDir(
      currentPath: string,
      basePath: string,
      depth: number,
    ): Promise<FileEntry[]> {
      if (depth > 5) return [];
      let results: FileEntry[] = [];
      try {
        const entries = await readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === "generation-manifest.json") continue;
          const absPath = `${currentPath}/${entry.name}`;
          const relPath = absPath.slice(basePath.length).replace(/^[/\\]/, "");
          if (entry.isDirectory()) {
            const nested = await walkDir(absPath, basePath, depth + 1);
            results = results.concat(nested);
          } else if (entry.isFile()) {
            results.push({
              name: entry.name,
              relativePath: relPath,
              absolutePath: absPath,
            });
          }
        }
      } catch {
        // Non-fatal
      }
      return results;
    }

    return walkDir(dirPath, dirPath, 0);
  });

  ipcMain.handle("files:openInExplorer", async (_event, dirPath: string) => {
    await shell.openPath(dirPath);
  });

  // Open a URL in the user's default browser (z43-followup, RFC 8252 native
  // OAuth flow). Only http(s) URLs are honored — anything else is rejected so
  // the renderer can't trick main into launching e.g. file:// or javascript:.
  ipcMain.handle("shell:openExternal", async (_event, url: string) => {
    if (typeof url !== "string") throw new Error("invalid url");
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      throw new Error(`shell:openExternal refuses protocol ${u.protocol}`);
    }
    await shell.openExternal(url);
  });
}
