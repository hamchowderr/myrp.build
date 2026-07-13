import { describe, expect, it } from "vitest";
import type { Workspace } from "../../src/renderer/src/lib/account";
import { deriveActiveId } from "../../src/renderer/src/lib/active-workspace";

// Teams epic: the workspace switcher's active-selection
// rule. Persisted pointer wins when still a member; else personal; else first.
const personal: Workspace = {
  workspaceId: "p1",
  name: "Personal",
  isPersonal: true,
  role: "owner",
  plan: "free",
};
const teamA: Workspace = {
  workspaceId: "t1",
  name: "Team A",
  isPersonal: false,
  role: "developer",
  plan: "pro",
};
const teamB: Workspace = {
  workspaceId: "t2",
  name: "Team B",
  isPersonal: false,
  role: "owner",
  plan: "free",
};

describe("deriveActiveId", () => {
  it("honors the persisted pointer when the user is still a member", () => {
    expect(deriveActiveId([personal, teamA, teamB], "t1")).toBe("t1");
    expect(deriveActiveId([personal, teamA, teamB], "t2")).toBe("t2");
  });

  it("falls back to the personal workspace when the pointer is unset", () => {
    expect(deriveActiveId([personal, teamA], null)).toBe("p1");
  });

  it("falls back to personal when the pointer points at a workspace they left", () => {
    // persisted "t9" is no longer in the list (removed/left) -> personal wins.
    expect(deriveActiveId([personal, teamA], "t9")).toBe("p1");
  });

  it("falls back to the first workspace when there is no personal one", () => {
    expect(deriveActiveId([teamA, teamB], null)).toBe("t1");
    expect(deriveActiveId([teamA, teamB], "t9")).toBe("t1");
  });

  it("returns null when the user has no workspaces", () => {
    expect(deriveActiveId([], null)).toBeNull();
    expect(deriveActiveId([], "t1")).toBeNull();
  });
});
