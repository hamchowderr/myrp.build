/**
 * Invite-by-email form (teams epic). Owner-only (the dialog
 * gates rendering; create_invitation re-checks ownership server-side). Creates a
 * pending workspace_invitations row matched to the invitee by email on next sign-in.
 */
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { supabase } from "@renderer/lib/supabase";
import { Loader2, UserPlus } from "lucide-react";
import { useState } from "react";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InviteForm({
  workspaceId,
  onInvited,
  onError,
}: {
  workspaceId: string;
  onInvited: () => void;
  onError: (msg: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      onError("Enter a valid email address.");
      return;
    }
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.rpc("create_invitation", {
      p_workspace_id: workspaceId,
      p_invitee_email: trimmed,
    });
    setBusy(false);
    if (error) {
      onError(error.message);
      return;
    }
    setEmail("");
    onInvited();
  };

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
        Invite by email
      </p>
      <div className="flex items-center gap-2">
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="developer@example.com"
          className="h-8 text-xs"
          disabled={busy}
        />
        <Button
          size="sm"
          className="h-8 shrink-0 gap-1.5 text-xs"
          disabled={busy || email.trim() === ""}
          onClick={() => void submit()}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <UserPlus className="size-3" />}
          Invite
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">
        They'll see the invite the next time they sign in. Developers can build but not manage
        billing or members.
      </p>
    </div>
  );
}
