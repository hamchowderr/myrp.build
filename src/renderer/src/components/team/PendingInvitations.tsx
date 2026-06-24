/**
 * Pending invitations surface (teams epic 1gf, fivem-studio-96l).
 *
 * On sign-in, polls get_my_pending_invitations (email-matched, RLS-scoped) and
 * shows a bell with a count badge when invites exist. Accept (accept_invitation)
 * joins the workspace and switches to it; decline (decline_invitation) dismisses.
 * After either action the list refreshes; onAccepted lets the parent refresh the
 * workspace list so the new workspace appears in the switcher.
 */
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { useAccount, type WorkspaceRole } from "@renderer/lib/account";
import { supabase } from "@renderer/lib/supabase";
import { Bell, Check, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface PendingInvite {
  id: string;
  workspace_id: string;
  workspace_name: string;
  inviter_email: string | null;
  invitee_role: WorkspaceRole;
  created_at: string;
  expires_at: string;
}

export function PendingInvitations({ onAccepted }: { onAccepted?: () => void }) {
  const { switchWorkspace } = useAccount();
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase.rpc("get_my_pending_invitations");
    setInvites((data ?? []) as PendingInvite[]);
  }, []);

  // Fetch once on mount (i.e. once per sign-in — the provider is keyed by user id).
  useEffect(() => {
    void load();
  }, [load]);

  const accept = async (inv: PendingInvite) => {
    if (!supabase) return;
    setBusyId(inv.id);
    const { data, error } = await supabase.rpc("accept_invitation", { p_invitation_id: inv.id });
    setBusyId(null);
    if (error) return;
    await load();
    onAccepted?.();
    // Jump straight into the workspace they just joined.
    if (typeof data === "string") await switchWorkspace(data);
  };

  const decline = async (inv: PendingInvite) => {
    if (!supabase) return;
    setBusyId(inv.id);
    const { error } = await supabase.rpc("decline_invitation", { p_invitation_id: inv.id });
    setBusyId(null);
    if (!error) await load();
  };

  if (invites.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative size-7 p-0 text-muted-foreground hover:text-foreground"
          aria-label={`${invites.length} pending invitation${invites.length === 1 ? "" : "s"}`}
        >
          <Bell className="size-4" />
          <span className="-right-0.5 -top-0.5 absolute flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-semibold text-primary-foreground">
            {invites.length}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
          Workspace invitations
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="max-h-72 overflow-y-auto">
          {invites.map((inv) => (
            <div key={inv.id} className="px-2 py-2">
              <p className="truncate text-xs font-medium">{inv.workspace_name}</p>
              <p className="truncate text-[10px] text-muted-foreground">
                {inv.inviter_email ? `from ${inv.inviter_email} · ` : ""}
                <Badge
                  variant="secondary"
                  className="px-1 py-0 text-[8px] font-normal uppercase tracking-wide"
                >
                  {inv.invitee_role}
                </Badge>
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-6 flex-1 gap-1 text-[11px]"
                  disabled={busyId === inv.id}
                  onClick={() => void accept(inv)}
                >
                  <Check className="size-3" /> Accept
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 flex-1 gap-1 text-[11px]"
                  disabled={busyId === inv.id}
                  onClick={() => void decline(inv)}
                >
                  <X className="size-3" /> Decline
                </Button>
              </div>
            </div>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
