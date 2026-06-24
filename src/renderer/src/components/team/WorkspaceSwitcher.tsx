/**
 * Workspace switcher (teams epic 1gf, fivem-studio-nqy).
 *
 * A compact dropdown in the account/footer area listing every workspace the user
 * belongs to (personal first), with a check on the active one. Selecting one calls
 * switchWorkspace (persists app_users.active_workspace_id), which makes the active
 * workspace the single source of truth that chat + billing read downstream.
 *
 * Owner/Developer role is shown as a small badge. "Manage team" opens the team
 * management dialog (nev). Pending-invite surfacing (96l) renders alongside.
 */
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";
import { useAccount } from "@renderer/lib/account";
import { Check, ChevronsUpDown, Plus, Users } from "lucide-react";

export function WorkspaceSwitcher({
  onManageTeam,
  onCreateTeam,
}: {
  onManageTeam?: () => void;
  onCreateTeam?: () => void;
}) {
  const { workspaces, workspaceId, switchWorkspace, workspacesLoading } = useAccount();

  // Nothing to switch between until the list resolves with >0 workspaces. A
  // single personal workspace still renders (so "Create team" is reachable).
  if (workspacesLoading || workspaces.length === 0) return null;

  const active = workspaces.find((w) => w.workspaceId === workspaceId) ?? workspaces[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 max-w-44 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
          aria-label="Switch workspace"
        >
          <Users className="size-3.5 shrink-0" />
          <span className="truncate">{active.name}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-widest text-muted-foreground/60">
          Workspaces
        </DropdownMenuLabel>
        {workspaces.map((w) => (
          <DropdownMenuItem
            key={w.workspaceId}
            onClick={() => {
              if (w.workspaceId !== workspaceId) void switchWorkspace(w.workspaceId);
            }}
            className="gap-2"
          >
            <Check
              className={`size-3.5 shrink-0 ${w.workspaceId === active.workspaceId ? "opacity-100" : "opacity-0"}`}
            />
            <span className="min-w-0 flex-1 truncate">{w.name}</span>
            <Badge
              variant="secondary"
              className="shrink-0 px-1.5 py-0 text-[9px] font-normal uppercase tracking-wide"
            >
              {w.isPersonal ? "personal" : w.role}
            </Badge>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {onManageTeam ? (
          <DropdownMenuItem onClick={onManageTeam} className="gap-2">
            <Users className="size-3.5 shrink-0 opacity-70" />
            Manage team
          </DropdownMenuItem>
        ) : null}
        {onCreateTeam ? (
          <DropdownMenuItem onClick={onCreateTeam} className="gap-2">
            <Plus className="size-3.5 shrink-0 opacity-70" />
            Create team workspace
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
