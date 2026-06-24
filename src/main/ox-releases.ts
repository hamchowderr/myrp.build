/**
 * Curated ox-ecosystem release downloads (shared by the agent's install_resource
 * tool and the new-server scaffolder, m8se.4).
 *
 * Only the official Overextended / CommunityOx release zips — no arbitrary URLs
 * (no supply-chain surface). Windows-only extraction via .NET ZipFile, which
 * takes LITERAL paths (Expand-Archive mis-parses the "[ox]" folder as a wildcard).
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import log from "electron-log/main";

const execFileAsync = promisify(execFile);

/** Official release-zip URLs for the ox ecosystem (curated — no arbitrary downloads). */
export const OX_RELEASES: Record<string, string> = {
  ox_lib: "https://github.com/overextended/ox_lib/releases/latest/download/ox_lib.zip",
  oxmysql: "https://github.com/overextended/oxmysql/releases/latest/download/oxmysql.zip",
  ox_core: "https://github.com/overextended/ox_core/releases/latest/download/ox_core.zip",
  ox_inventory:
    "https://github.com/overextended/ox_inventory/releases/latest/download/ox_inventory.zip",
  ox_target: "https://github.com/overextended/ox_target/releases/latest/download/ox_target.zip",
  ox_doorlock:
    "https://github.com/overextended/ox_doorlock/releases/latest/download/ox_doorlock.zip",
  ox_fuel: "https://github.com/overextended/ox_fuel/releases/latest/download/ox_fuel.zip",
  ox_banking: "https://github.com/communityox/ox_banking/releases/latest/download/ox_banking.zip",
};

/** The ox base a fresh server is scaffolded with (load order matters: lib → mysql → core → inv). */
export const OX_BASE = ["ox_lib", "oxmysql", "ox_core", "ox_inventory"] as const;

/** Resources whose schema must be imported separately after install. */
export const NEEDS_SQL = new Set(["ox_core", "ox_doorlock"]);

/** Download `url` to `dest` (follows GitHub's redirect to the release CDN). */
export async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/**
 * Download a curated ox resource's release zip and extract it into `oxDir`
 * (resources/[ox]). Throws on an unknown resource or a download/extract failure.
 */
export async function downloadAndExtractOx(resource: string, oxDir: string): Promise<void> {
  const url = OX_RELEASES[resource];
  if (!url) throw new Error(`unknown ox resource: ${resource}`);
  await mkdir(oxDir, { recursive: true });
  const zipPath = join(tmpdir(), `fxs-${resource}-${Date.now()}.zip`);
  await download(url, zipPath);
  // .NET ZipFile — literal-path safe for the "[ox]" folder (Expand-Archive isn't).
  const ps = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replace(/'/g, "''")}', '${oxDir.replace(/'/g, "''")}')`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps]);
  log.info(`[ox-releases] ${resource} extracted to [ox]`);
}
