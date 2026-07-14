/**
 * Team management dialog (teams epic).
 *
 * Operates on the ACTIVE workspace (from useAccount, set by the switcher):
 *  - lists members + roles (get_workspace_members),
 *  - owner-only: invite by email (create_invitation), remove a member
 *    (remove_member), revoke a pending invite (revoke_invitation),
 *  - developer: self-leave a team workspace (leave_workspace),
 *  - create a new team workspace (create_team_workspace) from any workspace.
 *
 * Owner-only controls are gated on the active role (activeRole === "owner"); the
 * RPCs re-check ownership server-side, so the UI gate is purely UX. All writes go
 * through the SECURITY DEFINER RPCs (RLS is SELECT-only).
 */
import { Button } from "@renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { useAccount } from "@renderer/lib/account";
import { supabase } from "@renderer/lib/supabase";
import { useCallback, useEffect, useState } from "react";
import { CreateTeamForm } from "./CreateTeamForm";
import { InviteForm } from "./InviteForm";
import { type Member, MembersList } from "./MembersList";
import { PendingInvitesList, type SentInvite } from "./PendingInvitesList";

export function TeamManagementDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { workspaceId, workspaces, activeRole, refreshWorkspaces } = useAccount();
  const active = workspaces.find((w) => w.workspaceId === workspaceId);
  const isOwner = activeRole === "owner";
  const isPersonal = active?.isPersonal ?? false;

  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<SentInvite[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load members (any member may view) + the workspace's pending invites (owner
  // only — RLS returns nothing for a developer, which is fine: the list hides).
  const load = useCallback(async () => {
    if (!supabase || !workspaceId) return;
    setLoading(true);
    setError(null);
    const [m, inv] = await Promise.all([
      supabase.rpc("get_workspace_members", { p_workspace_id: workspaceId }),
      supabase
        .from("workspace_invitations")
        .select("id, invitee_email, invitee_role, created_at, expires_at")
        .eq("workspace_id", workspaceId)
        .eq("status", "active")
        .order("created_at", { ascending: false }),
    ]);
    if (m.error) setError(m.error.message);
    setMembers((m.data ?? []) as Member[]);
    setInvites((inv.data ?? []) as SentInvite[]);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm">{active?.name ?? "Workspace"} — Team</DialogTitle>
          <DialogDescription className="text-[11px]">
            {isPersonal
              ? "This is your personal workspace. Create a team workspace to collaborate."
              : isOwner
                ? "Manage who can build in this workspace."
                : "You're a developer in this workspace."}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/[0.05] px-3 py-2 text-[11px] text-destructive/80">
            {error}
          </div>
        ) : null}

        {!isPersonal && (
          <MembersList
            members={members}
            loading={loading}
            canRemove={isOwner}
            workspaceId={workspaceId}
            onChanged={() => void load()}
            onError={setError}
          />
        )}

        {isOwner && !isPersonal && workspaceId ? (
          <>
            <InviteForm
              workspaceId={workspaceId}
              onInvited={() => void load()}
              onError={setError}
            />
            <PendingInvitesList
              invites={invites}
              onChanged={() => void load()}
              onError={setError}
            />
          </>
        ) : null}

        {!isOwner && !isPersonal && workspaceId ? (
          <LeaveButton
            workspaceId={workspaceId}
            onLeft={() => {
              onOpenChange(false);
              void refreshWorkspaces();
            }}
            onError={setError}
          />
        ) : null}

        <CreateTeamForm
          onCreated={() => {
            void refreshWorkspaces();
          }}
          onError={setError}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Developer self-leave for a team workspace (leave_workspace). */
function LeaveButton({
  workspaceId,
  onLeft,
  onError,
}: {
  workspaceId: string;
  onLeft: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center justify-between border-t border-border/40 pt-3">
      <span className="text-[11px] text-muted-foreground">Leave this workspace.</span>
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs"
        disabled={busy}
        onClick={async () => {
          if (!supabase) return;
          setBusy(true);
          const { error } = await supabase.rpc("leave_workspace", { p_workspace_id: workspaceId });
          setBusy(false);
          if (error) onError(error.message);
          else onLeft();
        }}
      >
        Leave workspace
      </Button>
    </div>
  );
}
