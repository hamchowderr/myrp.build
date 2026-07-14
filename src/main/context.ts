import { access, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ServerContext } from "../renderer/src/lib/types";

/**
 * Scan common FXServer install locations on Windows for txData server profiles.
 * Returns an array of paths that contain a server.cfg file.
 */
export async function findServerPaths(): Promise<string[]> {
  const home = homedir();
  const drives = ["C:", "D:", "E:"];

  // Common FXServer root locations
  const roots: string[] = [];
  for (const drive of drives) {
    roots.push(join(drive, "FXServer"), join(drive, "FiveM"), join(drive, "cfx-server"));
  }
  roots.push(
    join(home, "FXServer"),
    join(home, "Desktop", "FXServer"),
    join(home, "Documents", "FXServer"),
  );

  const found: string[] = [];

  for (const root of roots) {
    try {
      await access(root);
    } catch {
      continue;
    }

    // Check for server.cfg directly in root
    try {
      await access(join(root, "server.cfg"));
      found.push(root);
      continue;
    } catch {
      // Not here, check txData subfolders
    }

    // Check txData/<profile>.base/ pattern (standard txAdmin layout)
    const txDataDir = join(root, "txData");
    try {
      const entries = await readdir(txDataDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const profilePath = join(txDataDir, entry.name);
        try {
          await access(join(profilePath, "server.cfg"));
          found.push(profilePath);
        } catch {
          // No server.cfg in this subfolder
        }
      }
    } catch {
      // No txData dir
    }

    // Check cfx-server-data pattern
    const cfxDataDir = join(root, "cfx-server-data");
    try {
      await access(join(cfxDataDir, "server.cfg"));
      found.push(cfxDataDir);
    } catch {
      // Not here
    }
  }

  return found;
}

/**
 * Try to find FXServer.exe given a known server data path.
 * Checks sibling/parent "server" folders and common install roots.
 */
export async function findServerExePath(serverPath: string): Promise<string | null> {
  const { dirname, join: pjoin } = await import("node:path");

  // Build candidate list relative to serverPath
  // e.g. C:\FXServer\cfx-server-data → C:\FXServer\server\FXServer.exe
  //      C:\FXServer\txData\Profile.base → C:\FXServer\server\FXServer.exe
  const parent = dirname(serverPath); // one level up
  const grandparent = dirname(parent); // two levels up

  const candidates = [
    pjoin(parent, "server", "FXServer.exe"),
    pjoin(grandparent, "server", "FXServer.exe"),
    pjoin(parent, "FXServer.exe"),
    pjoin(grandparent, "FXServer.exe"),
  ];

  // Also check common absolute roots on C/D/E drives
  for (const drive of ["C:", "D:", "E:"]) {
    for (const root of ["FXServer", "FiveM", "cfx-server"]) {
      candidates.push(pjoin(drive, root, "server", "FXServer.exe"));
      candidates.push(pjoin(drive, root, "FXServer.exe"));
    }
  }

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Not here
    }
  }

  return null;
}

export async function detectServerContext(
  serverPath: string,
  serverExePath?: string,
): Promise<ServerContext> {
  const serverCfgPath = join(serverPath, "server.cfg");
  let serverCfg = "";

  try {
    serverCfg = await readFile(serverCfgPath, "utf-8");
  } catch {
    throw new Error(`Could not read server.cfg at ${serverCfgPath}`);
  }

  const framework = detectFramework(serverCfg);
  const dbDriver = detectDbDriver(serverCfg);
  const inventory = detectInventory(serverCfg);
  const gameBuild = detectGameBuild(serverCfg);

  // Try to find resources in the actual data dir (handles txAdmin layouts)
  const dataDir = await findResourcesDataDir(serverPath, serverExePath);
  const resourceSearchPath = dataDir ?? serverPath;
  const existingResources = await listLocalResources(resourceSearchPath);

  const context: ServerContext = {
    framework,
    dbDriver,
    inventory,
    gameBuild,
    existingResources,
    serverCfgPath,
  };

  // Write context cache for agent reference
  const cachePath = join(serverPath, ".fivemgen.json");
  try {
    await writeFile(cachePath, JSON.stringify(context, null, 2), "utf-8");
  } catch {
    // Non-critical — silently ignore if we can't write the cache
  }

  return context;
}

function detectFramework(cfg: string): "ox_core" | "esx" | "qbcore" | "qbox" | "unknown" {
  // Order matters: qbox extends qbcore, so check qbox first
  if (/ensure\s+qbx_core/i.test(cfg)) return "qbox";
  if (/ensure\s+ox_core/i.test(cfg)) return "ox_core";
  if (/ensure\s+es_extended/i.test(cfg)) return "esx";
  if (/ensure\s+qb-core/i.test(cfg)) return "qbcore";
  return "unknown";
}

function detectDbDriver(cfg: string): "oxmysql" | "mysql-async" | "unknown" {
  if (/ensure\s+oxmysql/i.test(cfg)) return "oxmysql";
  if (/ensure\s+mysql-async/i.test(cfg)) return "mysql-async";
  return "unknown";
}

function detectInventory(cfg: string): "ox_inventory" | "qb-inventory" | "unknown" {
  if (/ensure\s+ox_inventory/i.test(cfg)) return "ox_inventory";
  if (/ensure\s+qb-inventory/i.test(cfg)) return "qb-inventory";
  return "unknown";
}

function detectGameBuild(cfg: string): string {
  const match = cfg.match(/sv_enforceGameBuild\s+(\S+)/i);
  return match ? match[1] : "unknown";
}

/**
 * Parse the rcon_password value out of a server.cfg string. Handles quoted and
 * unquoted values, and the `set ` convar prefix that externalized secrets files
 * use (`set rcon_password "x"`) — missing the prefix was part of 92fh:
 *   rcon_password "mypassword"
 *   rcon_password mypassword
 *   set rcon_password "mypassword"
 */
export function parseRconPassword(cfg: string): string | null {
  for (const line of cfg.split("\n")) {
    const match = line.trim().match(/^(?:set\s+)?rcon_password\s+"?([^"#\s]+)"?\s*(?:#.*)?$/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Resolve rcon_password by reading server.cfg AND following its `exec`/`@include`
 * directives — the password is almost always externalized into a gitignored
 * secrets cfg (e.g. `myrp-secrets.cfg`) that server.cfg `exec`s, so parsing only
 * server.cfg misses it (the root cause of the false "RCON isn't configured").
 * exec paths resolve relative to the cfg that declares them.
 * Bounded depth + a visited set guard against cycles.
 */
export async function resolveRconPasswordFromCfg(
  serverCfgPath: string,
  depth = 0,
  seen: Set<string> = new Set(),
): Promise<string | null> {
  if (depth > 4 || seen.has(serverCfgPath)) return null;
  seen.add(serverCfgPath);
  let cfg: string;
  try {
    cfg = await readFile(serverCfgPath, "utf-8");
  } catch {
    return null;
  }
  const direct = parseRconPassword(cfg);
  if (direct) return direct;

  const baseDir = dirname(serverCfgPath);
  for (const rawLine of cfg.split("\n")) {
    // FiveM splits a line on `;`, so an exec can share a line with other cmds.
    for (const segment of rawLine.split(";")) {
      const m = segment.trim().match(/^(?:exec|@?include)\s+"?([^"#\r\n]+?)"?\s*$/i);
      if (!m?.[1]) continue;
      const ref = m[1].trim();
      const refPath = isAbsolute(ref) ? ref : join(baseDir, ref);
      const found = await resolveRconPasswordFromCfg(refPath, depth + 1, seen);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The effective RCON password for a server: the explicit Settings override if
 * set, else parsed from server.cfg + the files it exec's. serverCfgPath defaults
 * to `<serverPath>/server.cfg`. Returns "" when none can be resolved.
 */
export async function resolveServerRconPassword(
  server: { rconPassword?: string; serverPath?: string },
  serverCfgPath?: string,
): Promise<string> {
  if (server.rconPassword) return server.rconPassword;
  const cfgPath =
    serverCfgPath ?? (server.serverPath ? join(server.serverPath, "server.cfg") : undefined);
  if (!cfgPath) return "";
  return (await resolveRconPasswordFromCfg(cfgPath)) ?? "";
}

/**
 * Auto-detect the directory containing FXServer's `resources/` folder.
 * In txAdmin setups, server.cfg lives in txData/<profile>.base/ but
 * resources live in a sibling like cfx-server-data/. This function
 * searches relative to both serverPath (where server.cfg is) and
 * serverExePath (where the exe lives) to find the actual data dir.
 *
 * Returns the directory that CONTAINS `resources/`, or null if not found.
 */
export async function findResourcesDataDir(
  serverPath: string,
  serverExePath?: string,
): Promise<string | null> {
  const { dirname: dn, join: pj } = await import("node:path");

  // Build candidate list — check directories that might contain resources/
  const candidates: string[] = [];

  // 1. serverPath itself (simplest case: server.cfg + resources in same dir)
  candidates.push(serverPath);

  // 2. Sibling directories of serverPath's parent
  //    e.g. serverPath = C:\FXServer\txData\Profile.base → parent = txData → grandparent = C:\FXServer
  const parent = dn(serverPath);
  const grandparent = dn(parent);
  candidates.push(grandparent); // C:\FXServer
  candidates.push(pj(grandparent, "cfx-server-data")); // C:\FXServer\cfx-server-data
  candidates.push(parent); // C:\FXServer\txData

  // 3. If we have the exe path, check relative to it too
  //    e.g. exePath = C:\FXServer\server\FXServer.exe → exeDir = server → exeParent = C:\FXServer
  if (serverExePath) {
    const exeDir = dn(serverExePath);
    const exeParent = dn(exeDir);
    candidates.push(exeParent); // C:\FXServer
    candidates.push(pj(exeParent, "cfx-server-data"));
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const norm = c.toLowerCase().replace(/\\/g, "/");
    if (seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });

  // Check each candidate for a resources/ subdirectory
  for (const dir of unique) {
    try {
      const resourcesDir = pj(dir, "resources");
      await access(resourcesDir);
      // Verify it actually contains subdirectories (not an empty folder)
      const entries = await readdir(resourcesDir, { withFileTypes: true });
      const hasDirs = entries.some((e) => e.isDirectory());
      if (hasDirs) {
        return dir;
      }
    } catch {
      // Not here, try next
    }
  }

  return null;
}

async function listLocalResources(serverPath: string): Promise<string[]> {
  // Try common resource folder patterns
  const candidates = [
    join(serverPath, "resources", "[local]"),
    join(serverPath, "resources", "local"),
    join(serverPath, "resources", "[custom]"),
    join(serverPath, "resources"),
  ];

  for (const dir of candidates) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => !name.startsWith("[") && !name.startsWith("."));
    } catch {
      // Try next candidate
    }
  }

  return [];
}
