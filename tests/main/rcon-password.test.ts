import { beforeEach, describe, expect, it, vi } from "vitest";

// rcon_password resolution must (1) accept the `set ` convar
// prefix and (2) follow server.cfg `exec`/`@include` into the gitignored secrets
// cfg where the password actually lives. fs is mocked so the test is hermetic.

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  // context.ts imports access/readdir/readFile/writeFile; only readFile is used here.
  access: vi.fn(),
  readdir: vi.fn(),
  readFile,
  writeFile: vi.fn(),
}));

import {
  parseRconPassword,
  resolveRconPasswordFromCfg,
  resolveServerRconPassword,
} from "../../src/main/context";

beforeEach(() => {
  readFile.mockReset();
});

/** Wire the mocked readFile to a path→contents map (POSIX-normalized keys). */
function withFiles(files: Record<string, string>) {
  readFile.mockImplementation(async (p: string) => {
    const key = String(p).replace(/\\/g, "/");
    if (key in files) return files[key];
    const err = new Error(`ENOENT: ${key}`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
}

describe("parseRconPassword", () => {
  it("reads a bare directive (quoted + unquoted)", () => {
    expect(parseRconPassword('rcon_password "secret123"')).toBe("secret123");
    expect(parseRconPassword("rcon_password secret123")).toBe("secret123");
  });

  it("reads the `set rcon_password` convar form", () => {
    expect(parseRconPassword('set rcon_password "fromSecrets"')).toBe("fromSecrets");
    expect(parseRconPassword('  set   rcon_password   "indented"')).toBe("indented");
  });

  it("returns null when absent", () => {
    expect(parseRconPassword("ensure myresource\nsv_hostname Test")).toBeNull();
  });
});

describe("resolveRconPasswordFromCfg", () => {
  it("follows an exec into a secrets cfg that uses `set`", async () => {
    withFiles({
      "C:/srv/server.cfg": "sv_hostname Test\nexec myrp-secrets.cfg\nensure foo",
      "C:/srv/myrp-secrets.cfg": 'set rcon_password "execd"',
    });
    expect(await resolveRconPasswordFromCfg("C:/srv/server.cfg")).toBe("execd");
  });

  it("prefers a directly-declared password over exec'd files", async () => {
    withFiles({
      "C:/srv/server.cfg": 'rcon_password "direct"\nexec myrp-secrets.cfg',
      "C:/srv/myrp-secrets.cfg": 'set rcon_password "execd"',
    });
    expect(await resolveRconPasswordFromCfg("C:/srv/server.cfg")).toBe("direct");
  });

  it("handles a quoted exec path and an exec sharing a line via ;", async () => {
    withFiles({
      "C:/srv/server.cfg": 'sv_maxclients 48; exec "secrets.cfg"',
      "C:/srv/secrets.cfg": 'set rcon_password "shared"',
    });
    expect(await resolveRconPasswordFromCfg("C:/srv/server.cfg")).toBe("shared");
  });

  it("returns null (no crash) on a missing exec target or cycle", async () => {
    withFiles({
      // server.cfg exec's itself (cycle) and a non-existent file
      "C:/srv/server.cfg": "exec server.cfg\nexec nope.cfg",
    });
    expect(await resolveRconPasswordFromCfg("C:/srv/server.cfg")).toBeNull();
  });
});

describe("resolveServerRconPassword", () => {
  it("prefers the explicit Settings override without touching the cfg", async () => {
    expect(
      await resolveServerRconPassword({ rconPassword: "override", serverPath: "C:/srv" }),
    ).toBe("override");
    expect(readFile).not.toHaveBeenCalled();
  });

  it("derives <serverPath>/server.cfg and follows exec when no override", async () => {
    withFiles({
      "C:/srv/server.cfg": "exec myrp-secrets.cfg",
      "C:/srv/myrp-secrets.cfg": 'set rcon_password "derived"',
    });
    expect(await resolveServerRconPassword({ serverPath: "C:/srv" })).toBe("derived");
  });

  it("returns '' when nothing resolves", async () => {
    withFiles({ "C:/srv/server.cfg": "sv_hostname Test" });
    expect(await resolveServerRconPassword({ serverPath: "C:/srv" })).toBe("");
  });
});
