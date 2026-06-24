/**
 * Pure active-workspace selection (teams epic 1gf, fivem-studio-nqy).
 *
 * Extracted from useWorkspaces so the selection rule is unit-testable without
 * React/Supabase. The active workspace is: the persisted pointer when the user is
 * still a member of it, else their personal workspace, else the first workspace,
 * else null (no workspaces).
 */
import type { Workspace } from "@renderer/lib/account";

export function deriveActiveId(workspaces: Workspace[], persisted: string | null): string | null {
  if (persisted && workspaces.some((w) => w.workspaceId === persisted)) return persisted;
  const personal = workspaces.find((w) => w.isPersonal);
  return personal?.workspaceId ?? workspaces[0]?.workspaceId ?? null;
}
