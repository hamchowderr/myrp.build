/**
 * Active-workspace state + the workspace list (teams epic 1gf, fivem-studio-nqy).
 *
 * The single source of truth for "which workspace is active" lives in
 * app_users.active_workspace_id (persisted server-side). This hook:
 *  - lists every workspace the user belongs to (list_my_workspaces),
 *  - reads the persisted active pointer (app_users.active_workspace_id), falling
 *    back to the personal workspace when unset,
 *  - persists a switch via set_active_workspace and re-derives the active id.
 *
 * It owns NO billing — AuthApp's SupabaseAccountProvider reacts to activeWorkspaceId
 * to re-fetch get_subscription, so the switcher drives plan/usage/checkout/portal.
 * Lives in the lazy AuthApp module's dependency graph (imports @supabase), so it
 * never enters the dev-bypass startup chunk.
 */

import type { Plan, Workspace, WorkspaceRole } from "@renderer/lib/account";
import { deriveActiveId } from "@renderer/lib/active-workspace";
import { supabase } from "@renderer/lib/supabase";
import { useCallback, useEffect, useState } from "react";

interface WorkspacesState {
  workspaces: Workspace[];
  /** Persisted active workspace id (null until first load resolves). */
  activeWorkspaceId: string | null;
  /** The active workspace's role for this user (gates owner-only UI). */
  activeRole?: WorkspaceRole;
  loading: boolean;
  switchWorkspace: (workspaceId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useWorkspaces(): WorkspacesState {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Pull the workspace list + the persisted active pointer together, then derive
  // the active id (fail-soft: any error leaves an empty list and null active id,
  // and AuthApp falls back to get_subscription()'s personal default).
  const load = useCallback(async () => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const [wsRes, userRes] = await Promise.all([
      supabase.rpc("list_my_workspaces"),
      supabase.from("app_users").select("active_workspace_id").maybeSingle(),
    ]);
    const rows = (wsRes.data ?? []) as {
      workspace_id: string;
      name: string;
      is_personal: boolean;
      role: WorkspaceRole;
      plan: string;
    }[];
    const list: Workspace[] = rows.map((r) => ({
      workspaceId: r.workspace_id,
      name: r.name,
      isPersonal: r.is_personal,
      role: r.role,
      plan: (r.plan as Plan) ?? "free",
    }));
    const persisted = (userRes.data?.active_workspace_id as string | null) ?? null;
    setWorkspaces(list);
    setActiveWorkspaceId(deriveActiveId(list, persisted));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const switchWorkspace = useCallback(
    async (workspaceId: string) => {
      if (!supabase) return;
      // Optimistic: flip the active id immediately (so billing re-fetches), then
      // persist. On failure, reload to re-sync from the server's truth.
      setActiveWorkspaceId(workspaceId);
      const { error } = await supabase.rpc("set_active_workspace", {
        p_workspace_id: workspaceId,
      });
      if (error) await load();
    },
    [load],
  );

  const activeRole = workspaces.find((w) => w.workspaceId === activeWorkspaceId)?.role;

  return { workspaces, activeWorkspaceId, activeRole, loading, switchWorkspace, refresh: load };
}
