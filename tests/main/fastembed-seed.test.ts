import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fastembed model pre-seed copy logic. The module imports electron + electron-log
// at load; stub both so we can exercise the pure copy helper hermetically on real temp
// dirs (the copy is fs-level, so a real filesystem is the honest test surface).
vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("electron-log/main", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { seedModelDir } from "../../src/main/bootstrap/fastembed-seed";

const MODEL = "fast-bge-small-en-v1.5";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fastembed-seed-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Lay down a fake bundled model dir with one weight file. */
function makeBundle(): string {
  const bundledModelDir = join(root, "resources", "fastembed-models", MODEL);
  mkdirSync(bundledModelDir, { recursive: true });
  writeFileSync(join(bundledModelDir, "model_optimized.onnx"), "weights");
  return bundledModelDir;
}

describe("seedModelDir", () => {
  it("copies the bundled model into the cache when it is missing", () => {
    const bundledModelDir = makeBundle();
    const cacheRoot = join(root, "cache");
    const cacheModelDir = join(cacheRoot, MODEL);

    const outcome = seedModelDir({ bundledModelDir, cacheRoot, cacheModelDir });

    expect(outcome).toBe("seeded");
    expect(readFileSync(join(cacheModelDir, "model_optimized.onnx"), "utf8")).toBe("weights");
  });

  it("skips when the cache already holds the model (idempotent, no re-copy)", () => {
    const bundledModelDir = makeBundle();
    const cacheRoot = join(root, "cache");
    const cacheModelDir = join(cacheRoot, MODEL);
    mkdirSync(cacheModelDir, { recursive: true });
    writeFileSync(join(cacheModelDir, "model_optimized.onnx"), "existing");

    const outcome = seedModelDir({ bundledModelDir, cacheRoot, cacheModelDir });

    expect(outcome).toBe("skip-exists");
    // Existing cache is untouched — the bundled copy did not clobber it.
    expect(readFileSync(join(cacheModelDir, "model_optimized.onnx"), "utf8")).toBe("existing");
  });

  it("no-ops when no bundled model is present (falls back to runtime download)", () => {
    const cacheRoot = join(root, "cache");
    const cacheModelDir = join(cacheRoot, MODEL);

    const outcome = seedModelDir({
      bundledModelDir: join(root, "resources", "fastembed-models", MODEL),
      cacheRoot,
      cacheModelDir,
    });

    expect(outcome).toBe("skip-no-bundle");
    expect(existsSync(cacheModelDir)).toBe(false);
  });
});
