import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWriteTracker, resourceNameFromRel } from "../../src/main/ipc/generation-finalize";

/**
 * The write-tracking shared by the legacy and Harness paths.
 * Pure path logic + snapshot-before-overwrite, so both paths build the same
 * GenerationResult (file tree + undo) regardless of which engine wrote the files.
 */
describe("resourceNameFromRel", () => {
  it("extracts the resource folder after [local] (both slash styles)", () => {
    expect(resourceNameFromRel("[local]/heal-command/server/main.lua")).toBe("heal-command");
    expect(resourceNameFromRel("[local]\\carwash\\client.lua")).toBe("carwash");
  });
  it("falls back to the first segment when there's no [local]", () => {
    expect(resourceNameFromRel("carwash/fxmanifest.lua")).toBe("carwash");
  });
});

describe("createWriteTracker", () => {
  let root: string; // resources/ (resourcesRoot)
  let localDir: string; // resources/[local] (server.localPath)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wt-root-"));
    localDir = join(root, "[local]");
    mkdirSync(localDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("collects absolute write paths under the resources root", () => {
    const t = createWriteTracker({ localPath: localDir }, root);
    t.trackPath("[local]/carwash/fxmanifest.lua");
    t.trackPath("[local]/carwash/client.lua");
    expect([...t.writtenAbs]).toEqual([
      join(root, "[local]/carwash/fxmanifest.lua"),
      join(root, "[local]/carwash/client.lua"),
    ]);
  });

  it("snapshots an existing resource exactly once before overwrite", () => {
    const carwash = join(localDir, "carwash");
    mkdirSync(carwash, { recursive: true });
    writeFileSync(join(carwash, "fxmanifest.lua"), "old");
    const t = createWriteTracker({ localPath: localDir }, root);

    t.trackPath("[local]/carwash/fxmanifest.lua");
    const first = t.backupPath;
    expect(first).toBeTruthy();
    expect(existsSync(first as string)).toBe(true);

    // A second write into the SAME resource must not take another snapshot.
    t.trackPath("[local]/carwash/client.lua");
    expect(t.backupPath).toBe(first);
  });

  it("does not snapshot a brand-new resource", () => {
    const t = createWriteTracker({ localPath: localDir }, root);
    t.trackPath("[local]/brandnew/fxmanifest.lua");
    expect(t.backupPath).toBeUndefined();
  });
});
