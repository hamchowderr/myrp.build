import { describe, expect, it } from "vitest";
import {
  addServer,
  getActiveServer,
  markOpened,
  migrateSettings,
  setActiveServer,
  upsertActiveServer,
} from "../../src/renderer/src/lib/server-registry";
import type { AppSettings } from "../../src/renderer/src/lib/types";

// The local server registry is the SINGLE source of truth
// for per-server connection config. These tests pin the migration + accessor
// contract that keeps any one field from living in two places.

describe("migrateSettings", () => {
  it("promotes legacy flat settings into a single active record", () => {
    const migrated = migrateSettings({
      serverPath: "C:/srv/MyServer_AB12CD.base",
      localPath: "C:/srv/resources/[local]",
      serverPort: 30200,
      rconPassword: "secret",
      txAdminUrl: "http://127.0.0.1:40120",
      requireApproval: true,
    });
    expect(migrated.servers).toHaveLength(1);
    const [record] = migrated.servers;
    expect(migrated.activeServerId).toBe(record.id);
    expect(record.serverPath).toBe("C:/srv/MyServer_AB12CD.base");
    expect(record.serverPort).toBe(30200);
    expect(record.rconPassword).toBe("secret");
    // app-level flag stays at the top, not on the record
    expect(migrated.requireApproval).toBe(true);
    expect(record.name).toBe("My Server");
  });

  it("is idempotent on already-migrated settings and repairs a dangling active id", () => {
    const once = migrateSettings({
      serverPath: "C:/srv/a",
      localPath: "C:/srv/a/resources/[local]",
    });
    const twice = migrateSettings(once);
    expect(twice.servers).toHaveLength(1);
    expect(twice.activeServerId).toBe(once.servers[0].id);

    const dangling = migrateSettings({ ...once, activeServerId: "ghost" });
    expect(dangling.activeServerId).toBe(once.servers[0].id);
  });

  it("returns an empty registry for null/garbage", () => {
    expect(migrateSettings(null)).toEqual({
      servers: [],
      activeServerId: null,
      requireApproval: undefined,
    });
    expect(migrateSettings({}).servers).toHaveLength(0);
  });
});

describe("getActiveServer", () => {
  it("resolves the active id, falling back to the first record, then null", () => {
    const empty: AppSettings = { servers: [], activeServerId: null };
    expect(getActiveServer(empty)).toBeNull();

    const a = addServer(empty, "C:/srv/a").settings;
    const b = addServer(a, "C:/srv/b").settings; // b becomes active
    expect(getActiveServer(b)?.serverPath).toBe("C:/srv/b");

    // dangling active id → first record
    expect(getActiveServer({ ...b, activeServerId: "ghost" })?.serverPath).toBe("C:/srv/a");
  });
});

describe("addServer", () => {
  it("registers a new server and makes it active without clobbering others", () => {
    const start: AppSettings = { servers: [], activeServerId: null };
    const { settings: one } = addServer(start, "C:/srv/a");
    const { settings: two } = addServer(one, "C:/srv/b");
    expect(two.servers.map((s) => s.serverPath)).toEqual(["C:/srv/a", "C:/srv/b"]);
    expect(getActiveServer(two)?.serverPath).toBe("C:/srv/b");
  });

  it("re-selects an existing path instead of duplicating it", () => {
    const { settings: one } = addServer({ servers: [], activeServerId: null }, "C:/srv/a");
    const { settings: two } = addServer(one, "C:/srv/b");
    const { settings: again, record } = addServer(two, "C:/srv/a");
    expect(again.servers).toHaveLength(2); // no duplicate
    expect(again.activeServerId).toBe(record.id);
    expect(getActiveServer(again)?.serverPath).toBe("C:/srv/a");
  });
});

describe("upsertActiveServer / setActiveServer", () => {
  it("patches only the active record, leaving siblings untouched", () => {
    const { settings: one } = addServer({ servers: [], activeServerId: null }, "C:/srv/a");
    const { settings: two } = addServer(one, "C:/srv/b"); // b active
    const patched = upsertActiveServer(two, { serverPort: 30210, rconPassword: "pw" });
    const a = patched.servers.find((s) => s.serverPath === "C:/srv/a");
    const b = patched.servers.find((s) => s.serverPath === "C:/srv/b");
    expect(b?.serverPort).toBe(30210);
    expect(b?.rconPassword).toBe("pw");
    expect(a?.serverPort).toBeUndefined(); // sibling untouched
  });

  it("markOpened activates a server and stamps lastOpenedAt (pure, given now)", () => {
    const { settings: one } = addServer({ servers: [], activeServerId: null }, "C:/srv/a");
    const { settings: two } = addServer(one, "C:/srv/b"); // b active
    const aId = two.servers[0].id;
    const opened = markOpened(two, aId, 1_700_000_000_000);
    expect(opened.activeServerId).toBe(aId);
    expect(opened.servers.find((s) => s.id === aId)?.lastOpenedAt).toBe(1_700_000_000_000);
    expect(opened.servers.find((s) => s.serverPath === "C:/srv/b")?.lastOpenedAt).toBeUndefined();
    // unknown id → no-op
    expect(markOpened(two, "ghost", 123)).toBe(two);
  });

  it("setActiveServer switches selection without editing any record", () => {
    const { settings: one } = addServer({ servers: [], activeServerId: null }, "C:/srv/a");
    const { settings: two } = addServer(one, "C:/srv/b");
    const aId = two.servers[0].id;
    const switched = setActiveServer(two, aId);
    expect(switched.activeServerId).toBe(aId);
    expect(switched.servers).toEqual(two.servers);
  });
});
