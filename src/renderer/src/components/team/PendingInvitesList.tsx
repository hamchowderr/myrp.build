/**
 * Owner's view of a workspace's outstanding (sent) invitations with revoke
 * (teams epic). Rows come from the RLS-readable
 * workspace_invitations table (owner-readable); revoke goes through revoke_invitation.
 */
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import type { WorkspaceRole } from "@renderer/lib/account";
import { supabase } from "@renderer/lib/supabase";
import { X } from "lucide-react";

export interface SentInvite {
  id: string;
  invitee_email: string;
  invitee_role: WorkspaceRole;
  created_at: string;
  expires_at: string;
}

export function PendingInvitesList({
  invites,
  onChanged,
  onError,
}: {
  invites: SentInvite[];
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  if (invites.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
        Pending invites ({invites.length})
      </p>
      <ul className="divide-y divide-border/40">
        {invites.map((inv) => (
          <li key={inv.id} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0 flex-1 truncate text-xs">{inv.invitee_email}</span>
            <Badge
              variant="outline"
              className="shrink-0 px-1.5 py-0 text-[9px] font-normal uppercase tracking-wide"
            >
              {inv.invitee_role}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              className="size-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
              aria-label={`Revoke invite for ${inv.invitee_email}`}
              onClick={async () => {
                if (!supabase) return;
                const { error } = await supabase.rpc("revoke_invitation", {
                  p_invitation_id: inv.id,
                });
                if (error) onError(error.message);
                else onChanged();
              }}
            >
              <X className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
