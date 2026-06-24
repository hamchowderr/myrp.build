/**
 * Create a new team workspace (teams epic 1gf, fivem-studio-nev). Any signed-in
 * user can spin up a team workspace they own (create_team_workspace). After
 * creation the caller refreshes the workspace list (and can switch to it).
 */
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { supabase } from "@renderer/lib/supabase";
import { Loader2, Plus } from "lucide-react";
import { useState } from "react";

export function CreateTeamForm({
  onCreated,
  onError,
}: {
  onCreated: (workspaceId: string) => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed === "") {
      onError("Enter a workspace name.");
      return;
    }
    if (!supabase) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("create_team_workspace", { p_name: trimmed });
    setBusy(false);
    if (error) {
      onError(error.message);
      return;
    }
    setName("");
    setOpen(false);
    onCreated(data as string);
  };

  if (!open) {
    return (
      <div className="border-t border-border/40 pt-3">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() => setOpen(true)}
        >
          <Plus className="size-3" /> Create team workspace
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 border-t border-border/40 pt-3">
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
        New team workspace
      </p>
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="My RP Server"
          className="h-8 text-xs"
          disabled={busy}
        />
        <Button
          size="sm"
          className="h-8 shrink-0 gap-1.5 text-xs"
          disabled={busy || name.trim() === ""}
          onClick={() => void submit()}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
          Create
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 shrink-0 text-xs"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setName("");
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
