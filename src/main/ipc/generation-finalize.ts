/**
 * Post-generation finalization shared by the legacy agent.stream path and the
 * Harness path. Both turn the set of files a turn wrote into a
 * GenerationResult (file tree + undo manifest) the renderer's ArtifactPanel
 * consumes via `chat:result`, persist the `ensure` line + a generation-log row,
 * and trigger the optional auto-backup. Extracted so ipc/chat.ts doesn't grow
 * past the file-size cap and the two paths stay behaviorally identical.
 */
import { join } from "node:path";
import log from "electron-log/main";
import { appendEnsureLine, backupResourceSync, writeGenerationManifest } from "../fileWriter";
import { logGeneration } from "../generation-log";
import { scheduleAutoBackup } from "./backup";

const LOCAL_DIR = "[local]";

/** "[local]/heal-command/server/main.lua" -> "heal-command". */
export function resourceNameFromRel(rel: string): string | undefined {
  const parts = rel.replace(/\\/g, "/").split("/").filter(Boolean);
  const i = parts.indexOf(LOCAL_DIR);
  if (i >= 0 && parts.length > i + 1) return parts[i + 1];
  return parts.length > 1 ? parts[0] : undefined;
}

/**
 * Collects a turn's write_file targets and snapshots each resource before its
 * FIRST overwrite, so a regeneration is reversible (undo restores the original).
 * The legacy path feeds it from AI-SDK chunks; the Harness path from `tool_start`
 * events — both call {@link trackPath} with a workspace-relative path.
 */
export interface WriteTracker {
  readonly writtenAbs: Set<string>;
  readonly backupPath: string | undefined;
  trackPath(relPath: string): void;
}

export function createWriteTracker(
  server: { localPath: string },
  resourcesRoot: string,
): WriteTracker {
  const writtenAbs = new Set<string>();
  const backedUp = new Set<string>();
  let backupPath: string | undefined;
  return {
    writtenAbs,
    get backupPath() {
      return backupPath;
    },
    trackPath(relPath: string): void {
      writtenAbs.add(join(resourcesRoot, relPath));
      // First write into an existing resource → snapshot it BEFORE the write so
      // undo can restore the pre-overwrite original. Sync + fired on the tool
      // call ⇒ race-free; non-fatal.
      const resName = resourceNameFromRel(relPath);
      if (resName) {
        const resourceDir = join(server.localPath, resName);
        if (!backedUp.has(resourceDir)) {
          backedUp.add(resourceDir);
          const snapped = backupResourceSync(resourceDir, server.localPath);
          if (snapped) backupPath = snapped;
        }
      }
    },
  };
}

export interface FinalizeGenerationOptions {
  server: { localPath: string };
  resourcesRoot: string;
  writtenAbs: Set<string>;
  backupPath: string | undefined;
  /** server.cfg path for the auto-ensure line (omit to skip). */
  serverCfgPath?: string;
  prompt: string;
  model?: string;
  ragContext: string[];
  threadId: string;
  /** Forward an IPC message to the renderer (chat:result). */
  send: (channel: string, data: unknown) => void;
}

/**
 * Assemble the GenerationResult + persistence for a finished turn. When files
 * were written: write the undo manifest and emit `chat:result`, persist `ensure
 * <resource>` to server.cfg, and schedule the optional auto-backup. Always logs
 * the generation (fail-safe) and returns its id + the resource name.
 */
export async function finalizeGeneration(
  opts: FinalizeGenerationOptions,
): Promise<{ generationId: string | null; resourceName?: string }> {
  const { server, resourcesRoot, writtenAbs, backupPath, serverCfgPath, send } = opts;
  const paths = [...writtenAbs];
  let resourceName: string | undefined;
  if (paths.length > 0) {
    const firstRel = paths[0].slice(resourcesRoot.length + 1);
    resourceName = resourceNameFromRel(firstRel) ?? "resource";
    try {
      const result = await writeGenerationManifest(
        server.localPath,
        resourceName,
        paths,
        backupPath,
      );
      send("chat:result", result);
    } catch (err) {
      log.warn("[chat] manifest write failed:", err);
    }
    // Auto-ensure: persist `ensure <resource>` so it also
    // starts on the next boot. Idempotent + non-fatal; only with a known cfg.
    if (serverCfgPath) await appendEnsureLine(serverCfgPath, resourceName);
    // Optional debounced commit+push of the active server; no-op unless on.
    scheduleAutoBackup();
  }
  // Capture for the feedback/fine-tune dataset. Fail-safe — never blocks.
  const generationId = await logGeneration({
    prompt: opts.prompt,
    model: opts.model ?? process.env.MASTRA_MODEL ?? "anthropic/claude-sonnet-4-6",
    ragUsed: opts.ragContext.length > 0,
    ragChunkCount: opts.ragContext.length,
    resourceName,
    outputFiles: paths.map((p) => p.slice(resourcesRoot.length + 1)),
    threadId: opts.threadId,
  });
  return { generationId, resourceName };
}
