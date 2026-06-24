import { beforeEach, describe, expect, it, vi } from "vitest";

// fivem-studio-1yef.1: git-init a server folder + .gitignore + flag server.cfg
// secrets. fs + git are mocked so the test is hermetic (no real repo / disk).

const { access, readFile, writeFile, execFile } = vi.hoisted(() => ({
  access: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ access, readFile, writeFile }));
vi.mock("node:child_process", () => ({ execFile }));

import {
  autoBackupEligible,
  cloneServerRepo,
  commitAndPushServer,
  deriveRepoName,
  ensureGithubRepo,
  FIVEM_GITIGNORE,
  getGithubLogin,
  getGitRemoteUrl,
  gitInitServer,
  scanServerCfgSecrets,
  setGitRemote,
} from "../../src/main/server-backup";

/** Minimal Response-like stub for the global fetch mock. */
function ghResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  // promisify(execFile) → resolve via the callback.
  execFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, r: unknown) => void) =>
      cb(null, { stdout: "", stderr: "" }),
  );
  readFile.mockRejectedValue(new Error("ENOENT")); // no server.cfg unless a test sets it
});

describe("scanServerCfgSecrets (1yef.1)", () => {
  it("flags named secret directives + generic set <name>(key|token|...), skips benign + comments", async () => {
    readFile.mockResolvedValueOnce(
      [
        "# comment with rcon_password should be ignored",
        'sv_licenseKey "cfxk_xxx"',
        "set steam_webApiKey ABC123",
        "ensure ox_core", // benign
        'set mysql_connection_string "mysql://user:pw@host/db"',
        "rcon_password supersecret",
        'set discord_bot_token "xyz"',
        "endpoint_add_tcp 0.0.0.0:30120", // benign
      ].join("\n"),
    );
    const warnings = await scanServerCfgSecrets("C:/srv");
    const directives = warnings.map((w) => w.directive.toLowerCase());
    expect(directives).toContain("sv_licensekey");
    expect(directives).toContain("steam_webapikey");
    expect(directives).toContain("mysql_connection_string");
    expect(directives).toContain("rcon_password");
    expect(directives).toContain("discord_bot_token");
    // benign lines + the comment are not flagged
    expect(warnings).toHaveLength(5);
    expect(warnings[0].line).toBe(2); // 1-based; line 1 is the comment
  });

  it("returns [] when there is no server.cfg", async () => {
    expect(await scanServerCfgSecrets("C:/srv")).toEqual([]);
  });
});

describe("gitInitServer (1yef.1)", () => {
  it("inits a fresh folder, writes .gitignore, reports no prior repo", async () => {
    access.mockRejectedValue(new Error("ENOENT")); // neither .git nor .gitignore exist
    const res = await gitInitServer("C:/srv");
    expect(res.ok).toBe(true);
    expect(res.alreadyRepo).toBe(false);
    expect(res.gitignoreWritten).toBe(true);
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["init", "-b", "main"],
      expect.objectContaining({ cwd: "C:/srv" }),
      expect.any(Function),
    );
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining(".gitignore"),
      FIVEM_GITIGNORE,
      "utf8",
    );
  });

  it("skips init + .gitignore when the repo + ignore already exist", async () => {
    access.mockResolvedValue(undefined); // .git and .gitignore both present
    const res = await gitInitServer("C:/srv");
    expect(res.ok).toBe(true);
    expect(res.alreadyRepo).toBe(true);
    expect(res.gitignoreWritten).toBe(false);
    expect(execFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("returns an error result when git init fails", async () => {
    access.mockRejectedValue(new Error("ENOENT"));
    execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: unknown) => void) =>
      cb(new Error("git not found")),
    );
    const res = await gitInitServer("C:/srv");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/git not found/);
  });
});

describe("deriveRepoName (1yef.2)", () => {
  it("sanitizes a folder name to a valid GitHub repo name", () => {
    expect(deriveRepoName("C:/servers/My RP Server!")).toBe("My-RP-Server");
    expect(deriveRepoName("/home/me/fivem_core.dev")).toBe("fivem_core.dev");
  });
  it("falls back when the name reduces to empty", () => {
    expect(deriveRepoName("C:/servers/@@@")).toBe("fivem-server");
  });
});

describe("getGithubLogin (1yef.2)", () => {
  it("returns the login on 200", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ghResponse(200, { login: "octocat" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getGithubLogin("tok")).toBe("octocat");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/user");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
    vi.unstubAllGlobals();
  });
  it("throws a reconnect message on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ghResponse(401, "bad creds")));
    await expect(getGithubLogin("tok")).rejects.toThrow(/invalid or was revoked/i);
    vi.unstubAllGlobals();
  });
});

describe("ensureGithubRepo (1yef.2)", () => {
  it("returns the existing repo when lookup succeeds (no create)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      ghResponse(200, {
        full_name: "octocat/srv",
        clone_url: "https://github.com/octocat/srv.git",
        html_url: "https://github.com/octocat/srv",
        private: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const repo = await ensureGithubRepo("tok", { name: "srv", owner: "octocat" });
    expect(repo.fullName).toBe("octocat/srv");
    expect(repo.cloneUrl).toBe("https://github.com/octocat/srv.git");
    expect(fetchMock).toHaveBeenCalledTimes(1); // GET only
    vi.unstubAllGlobals();
  });

  it("creates a private personal repo when lookup 404s", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ghResponse(404, "Not Found"))
      .mockResolvedValueOnce(
        ghResponse(201, {
          full_name: "octocat/srv",
          clone_url: "https://github.com/octocat/srv.git",
          html_url: "https://github.com/octocat/srv",
          private: true,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const repo = await ensureGithubRepo("tok", { name: "srv", owner: "octocat", isPrivate: true });
    expect(repo.isPrivate).toBe(true);
    const [createUrl, init] = fetchMock.mock.calls[1];
    expect(createUrl).toBe("https://api.github.com/user/repos");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      name: "srv",
      private: true,
    });
    vi.unstubAllGlobals();
  });

  it("creates under an org when org is given", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ghResponse(404, "Not Found"))
      .mockResolvedValueOnce(
        ghResponse(201, {
          full_name: "myteam/srv",
          clone_url: "https://github.com/myteam/srv.git",
          html_url: "https://github.com/myteam/srv",
          private: true,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await ensureGithubRepo("tok", { name: "srv", owner: "octocat", org: "myteam" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/repos/myteam/srv");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.github.com/orgs/myteam/repos");
    vi.unstubAllGlobals();
  });
});

describe("setGitRemote (1yef.2)", () => {
  it("adds origin on a fresh repo", async () => {
    await setGitRemote("C:/srv", "https://github.com/me/repo.git");
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["remote", "add", "origin", "https://github.com/me/repo.git"],
      expect.objectContaining({ cwd: "C:/srv" }),
      expect.any(Function),
    );
  });

  it("repoints origin via set-url when add fails", async () => {
    execFile.mockImplementationOnce(
      (_c: string, _a: string[], _o: unknown, cb: (e: unknown) => void) =>
        cb(new Error("remote origin already exists")),
    );
    await setGitRemote("C:/srv", "https://github.com/me/repo.git");
    expect(execFile).toHaveBeenLastCalledWith(
      "git",
      ["remote", "set-url", "origin", "https://github.com/me/repo.git"],
      expect.objectContaining({ cwd: "C:/srv" }),
      expect.any(Function),
    );
  });
});

describe("getGitRemoteUrl (1yef.3)", () => {
  it("returns origin url, trimmed", async () => {
    execFile.mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb: (e: unknown, r: unknown) => void) =>
        cb(null, { stdout: "https://github.com/me/repo.git\n", stderr: "" }),
    );
    expect(await getGitRemoteUrl("C:/srv")).toBe("https://github.com/me/repo.git");
  });
  it("returns null when there is no origin", async () => {
    execFile.mockImplementation((_c: string, _a: string[], _o: unknown, cb: (e: unknown) => void) =>
      cb(new Error("No such remote 'origin'")),
    );
    expect(await getGitRemoteUrl("C:/srv")).toBeNull();
  });
});

describe("commitAndPushServer (1yef.3)", () => {
  // Route each git subcommand to a scripted result. `status` controls whether
  // there's anything to commit; `pushErr` simulates a push failure.
  function wireGit({ status = "", pushErr = null as Error | null } = {}) {
    access.mockResolvedValue(undefined); // .git exists → isGitRepo true
    execFile.mockImplementation(
      (_c: string, args: string[], _o: unknown, cb: (e: unknown, r?: unknown) => void) => {
        if (args.includes("status")) return cb(null, { stdout: status, stderr: "" });
        if (args.includes("rev-parse")) return cb(null, { stdout: "abc1234\n", stderr: "" });
        if (args.includes("push"))
          return pushErr ? cb(pushErr) : cb(null, { stdout: "", stderr: "" });
        return cb(null, { stdout: "", stderr: "" }); // add, commit
      },
    );
  }
  const opts = {
    token: "ghs_SECRETTOKEN",
    login: "octocat",
    remoteUrl: "https://github.com/octocat/srv.git",
  };

  it("commits and pushes when the tree is dirty", async () => {
    wireGit({ status: " M server.cfg\n" });
    const res = await commitAndPushServer("C:/srv", opts);
    expect(res).toMatchObject({ ok: true, committed: true, pushed: true, sha: "abc1234" });
    // commit ran with a per-commit identity (no dependence on global git config)
    const commitCall = execFile.mock.calls.find((c) => (c[1] as string[]).includes("commit"));
    expect(commitCall?.[1]).toEqual(expect.arrayContaining(["-c", "user.name=octocat"]));
  });

  it("skips the commit but still pushes when the tree is clean", async () => {
    wireGit({ status: "" });
    const res = await commitAndPushServer("C:/srv", opts);
    expect(res).toMatchObject({ ok: true, committed: false, pushed: true, nothingToCommit: true });
    expect(execFile.mock.calls.some((c) => (c[1] as string[]).includes("commit"))).toBe(false);
  });

  it("injects the token ONLY into the push url (never into commit/config)", async () => {
    wireGit({ status: " M f\n" });
    await commitAndPushServer("C:/srv", opts);
    const pushCall = execFile.mock.calls.find((c) => (c[1] as string[]).includes("push"));
    expect(pushCall?.[1]).toEqual(
      expect.arrayContaining([
        "push",
        "https://x-access-token:ghs_SECRETTOKEN@github.com/octocat/srv.git",
        "HEAD:main",
      ]),
    );
    // disables the credential helper so Git Credential Manager can't pop a GUI login
    expect(pushCall?.[1]).toEqual(expect.arrayContaining(["-c", "credential.helper="]));
    // the token must not appear in any non-push git invocation
    const nonPush = execFile.mock.calls.filter((c) => !(c[1] as string[]).includes("push"));
    expect(nonPush.some((c) => (c[1] as string[]).join(" ").includes(opts.token))).toBe(false);
  });

  it("scrubs the token from a push error", async () => {
    wireGit({
      status: " M f\n",
      pushErr: new Error(
        "fatal: unable to access https://x-access-token:ghs_SECRETTOKEN@github.com/octocat/srv.git/",
      ),
    });
    const res = await commitAndPushServer("C:/srv", opts);
    expect(res.ok).toBe(false);
    expect(res.error).not.toContain("ghs_SECRETTOKEN");
    expect(res.error).toContain("***");
  });

  it("errors when the folder is not a git repo", async () => {
    access.mockRejectedValue(new Error("ENOENT")); // no .git
    const res = await commitAndPushServer("C:/srv", opts);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a git repo/i);
  });
});

describe("cloneServerRepo (1yef.4)", () => {
  const opts = {
    token: "ghs_SECRET",
    remoteUrl: "https://github.com/octocat/srv.git",
    parentDir: "C:/restore",
  };

  it("clones with the token, then resets origin to the clean url", async () => {
    access.mockRejectedValue(new Error("ENOENT")); // dest does not exist
    const res = await cloneServerRepo(opts);
    expect(res.ok).toBe(true);
    expect(res.localPath).toMatch(/srv$/); // parentDir/<repoName>
    const cloneCall = execFile.mock.calls.find((c) => (c[1] as string[]).includes("clone"));
    expect(cloneCall?.[1]).toEqual(
      expect.arrayContaining([
        "clone",
        "https://x-access-token:ghs_SECRET@github.com/octocat/srv.git",
      ]),
    );
    // credential helper disabled so GCM can't pop a GUI / hang the clone
    expect(cloneCall?.[1]).toEqual(expect.arrayContaining(["-c", "credential.helper="]));
    const setUrl = execFile.mock.calls.find((c) =>
      (c[1] as string[]).join(" ").includes("remote set-url"),
    );
    // origin is reset to the CLEAN url — no token left in .git/config
    expect((setUrl?.[1] as string[])[3]).toBe("https://github.com/octocat/srv.git");
  });

  it("refuses to overwrite an existing folder", async () => {
    access.mockResolvedValue(undefined); // dest already exists
    const res = await cloneServerRepo(opts);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already exists/i);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("scrubs the token from a clone error", async () => {
    access.mockRejectedValue(new Error("ENOENT"));
    execFile.mockImplementation(
      (_c: string, a: string[], _o: unknown, cb: (e: unknown, r?: unknown) => void) =>
        a.includes("clone")
          ? cb(
              new Error(
                "fatal: unable to access https://x-access-token:ghs_SECRET@github.com/octocat/srv.git/",
              ),
            )
          : cb(null, { stdout: "", stderr: "" }),
    );
    const res = await cloneServerRepo(opts);
    expect(res.ok).toBe(false);
    expect(res.error).not.toContain("ghs_SECRET");
    expect(res.error).toContain("***");
  });
});

describe("autoBackupEligible (dbjw)", () => {
  const full = {
    enabled: true,
    serverPath: "C:/srv",
    token: "t",
    login: "octocat",
    remoteUrl: "https://github.com/o/r.git",
  };
  it("is true only when enabled + connected + linked", () => {
    expect(autoBackupEligible(full)).toBe(true);
  });
  it("is false when the toggle is off", () => {
    expect(autoBackupEligible({ ...full, enabled: false })).toBe(false);
  });
  it("is false when not connected (no token/login)", () => {
    expect(autoBackupEligible({ ...full, token: null })).toBe(false);
    expect(autoBackupEligible({ ...full, login: null })).toBe(false);
  });
  it("is false when no repo is linked or no active server", () => {
    expect(autoBackupEligible({ ...full, remoteUrl: null })).toBe(false);
    expect(autoBackupEligible({ ...full, serverPath: null })).toBe(false);
  });
});
