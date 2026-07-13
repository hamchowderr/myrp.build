/**
 * Members list for the active workspace (teams epic).
 * Renders each member with role; owners get a remove control (remove_member,
 * server-side owner-checked; owners can't be removed).
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@renderer/components/ui/alert-dialog";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import type { WorkspaceRole } from "@renderer/lib/account";
import { supabase } from "@renderer/lib/supabase";
import { Loader2, X } from "lucide-react";

export interface Member {
  user_id: string;
  email: string;
  role: WorkspaceRole;
  added_at: string;
}

export function MembersList({
  members,
  loading,
  canRemove,
  workspaceId,
  onChanged,
  onError,
}: {
  members: Member[];
  loading: boolean;
  canRemove: boolean;
  workspaceId?: string;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
        Members {members.length > 0 ? `(${members.length})` : ""}
      </p>
      {loading ? (
        <div className="flex items-center gap-1.5 py-3 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Loading members…
        </div>
      ) : (
        <ul className="divide-y divide-border/40">
          {members.map((m) => (
            <li key={m.user_id} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 flex-1 truncate text-xs">{m.email}</span>
              <Badge
                variant={m.role === "owner" ? "default" : "secondary"}
                className="shrink-0 px-1.5 py-0 text-[9px] font-normal uppercase tracking-wide"
              >
                {m.role}
              </Badge>
              {canRemove && m.role !== "owner" && workspaceId ? (
                <RemoveMemberButton
                  workspaceId={workspaceId}
                  userId={m.user_id}
                  email={m.email}
                  onChanged={onChanged}
                  onError={onError}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RemoveMemberButton({
  workspaceId,
  userId,
  email,
  onChanged,
  onError,
}: {
  workspaceId: string;
  userId: string;
  email: string;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="size-6 shrink-0 p-0 text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${email}`}
        >
          <X className="size-3.5" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-sm">Remove member?</AlertDialogTitle>
          <AlertDialogDescription className="text-[11px]">
            {email} will lose access to this workspace. They can be re-invited later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-7 text-xs">Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="h-7 text-xs"
            onClick={async () => {
              if (!supabase) return;
              const { error } = await supabase.rpc("remove_member", {
                p_workspace_id: workspaceId,
                p_user_id: userId,
              });
              if (error) onError(error.message);
              else onChanged();
            }}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
