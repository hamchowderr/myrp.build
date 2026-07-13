import { Avatar, AvatarFallback, AvatarImage } from "@renderer/components/ui/avatar";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Separator } from "@renderer/components/ui/separator";
import type { SettingsState } from "@renderer/hooks/useSettingsState";
import { useAccount } from "@renderer/lib/account";
import { CheckCircle2, LogOut, User } from "lucide-react";
import { SectionHeader, SettingsRow } from "./shared";

interface ProfileSectionProps {
  profile: SettingsState["profile"];
  setProfile: SettingsState["setProfile"];
  profileSaved: boolean;
  initials: string;
  onSave: () => void;
}

export function ProfileSection({
  profile,
  setProfile,
  profileSaved,
  initials,
  onSave,
}: ProfileSectionProps) {
  // Signed-in Discord identity (prod) — surfaces the user's avatar/name in the
  // profile preview; undefined in dev-bypass, where we fall back to initials.
  const { avatarUrl, displayName: accountName, signOut, isDev } = useAccount();
  return (
    <div className="space-y-0">
      <SectionHeader title="Profile" />
      <Separator className="mb-1" />

      {/* Avatar preview row */}
      <div className="flex items-center gap-4 py-5">
        <Avatar className="h-16 w-16">
          {avatarUrl ? (
            <AvatarImage src={avatarUrl} alt={accountName || profile.displayName || "Developer"} />
          ) : null}
          <AvatarFallback className="bg-primary/10 text-primary text-base font-semibold">
            {initials || <User className="size-5" />}
          </AvatarFallback>
        </Avatar>
        <div>
          <p className="text-sm font-semibold font-mono">
            {accountName || profile.displayName || "Developer"}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">myRP.build developer</p>
        </div>
      </div>

      <Separator />

      <SettingsRow
        label="Developer handle"
        description="Used in generated resource metadata and comments."
      >
        <div className="flex items-center gap-2">
          <Input
            value={profile.displayName}
            onChange={(e) =>
              setProfile((p) => ({
                ...p,
                displayName: e.target.value,
              }))
            }
            placeholder="Your handle or name"
            className="h-7 w-52 text-xs font-mono"
          />
          <Button
            size="sm"
            variant={profileSaved ? "ghost" : "default"}
            className="h-7 text-xs gap-1"
            onClick={onSave}
          >
            {profileSaved ? (
              <>
                <CheckCircle2 className="size-3 text-chart-2" />
                <span className="text-chart-2">Saved</span>
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </SettingsRow>

      {/* Sign out — relocated here from the chat footer (the Discord avatar/menu
          was removed). Prod only; dev-bypass has no session to end. */}
      {!isDev ? (
        <>
          <Separator />
          <SettingsRow label="Account" description="Sign out of your myRP.build account.">
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-xs"
              onClick={() => void signOut()}
            >
              <LogOut className="size-3" />
              Sign out
            </Button>
          </SettingsRow>
        </>
      ) : null}
    </div>
  );
}
