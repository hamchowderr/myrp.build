/**
 * Production auth + billing shell (native Supabase Auth).
 * Lazily imported by App.tsx ONLY when NOT in dev-bypass — so @supabase stays out
 * of the startup chunk for local owner testing.
 *
 * Identity is native Supabase Auth (Discord OAuth, PKCE). The session is durable
 * in Electron via the custom storage adapter on the Supabase client
 * (lib/supabase.ts), so it survives reload / >60s refresh / relaunch — the failure
 * mode that broke the prior in-memory auth here. On sign-in the handle_new_user() DB trigger
 * provisions the user + personal workspace; this shell just reads the JWT-scoped
 * subscription (get_subscription) and exposes Stripe checkout/portal + the account
 * slot to AppContent.
 */
import { ActiveThemeProvider } from "@renderer/components/active-theme";
import { PendingInvitations } from "@renderer/components/team/PendingInvitations";
import { TeamManagementDialog } from "@renderer/components/team/TeamManagementDialog";
import { WorkspaceSwitcher } from "@renderer/components/team/WorkspaceSwitcher";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { useWorkspaces } from "@renderer/hooks/useWorkspaces";
import { AccountContext, type AccountValue, type PaidTier, type Plan } from "@renderer/lib/account";
import { supabase } from "@renderer/lib/supabase";
import type { Session } from "@supabase/supabase-js";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { AppContent } from "./AppContent";
import { CustomAuth } from "./auth/CustomAuth";

interface SubscriptionRow {
  workspace_id: string;
  plan: Plan;
  usage_count: number;
  usage_limit: number;
  can_generate: boolean;
}

type SubState = Pick<
  AccountValue,
  "plan" | "usageCount" | "usageLimit" | "canGenerate" | "workspaceId" | "isLoading"
>;

const DEFAULT_SUB: SubState = {
  plan: "free",
  usageCount: 0,
  usageLimit: 10,
  canGenerate: true,
  isLoading: false,
};

/**
 * Supplies the real AccountContext value: the JWT-scoped subscription
 * (get_subscription, RLS by auth.uid()) plus Stripe checkout/portal actions and
 * the access-token getter for the inference proxy.
 */
function SupabaseAccountProvider({
  session,
  children,
}: {
  session: Session;
  children: ReactNode;
}): React.JSX.Element {
  const [sub, setSub] = useState<SubState>({ ...DEFAULT_SUB, isLoading: true });
  const [billingError, setBillingError] = useState<string | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const email = session.user.email ?? "";
  // Active-workspace state (teams epic): the list + the persisted active
  // pointer. activeWorkspaceId drives the subscription re-fetch below, so the
  // switcher is the single source of truth for plan/usage/checkout/portal.
  const {
    workspaces,
    activeWorkspaceId,
    activeRole,
    loading: workspacesLoading,
    switchWorkspace,
    refresh: refreshWorkspaces,
  } = useWorkspaces();
  // Discord OAuth identity: avatar + display name ride in
  // user_metadata (avatar_url/picture, full_name/name). Used for the profile photo.
  const meta = (session.user.user_metadata ?? {}) as Record<string, unknown>;
  const avatarUrl =
    (typeof meta.avatar_url === "string" && meta.avatar_url) ||
    (typeof meta.picture === "string" && meta.picture) ||
    undefined;
  const name =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    undefined;

  // Subscription/usage for the ACTIVE workspace (teams epic):
  // re-fetched whenever the active workspace changes, so switching workspaces
  // switches the plan/usage shown and the workspace billing acts on. Waits for the
  // active id to resolve (null while the list loads) to avoid a personal-default
  // flash; fail-open to DEFAULT. Re-keys on session.user.id via the parent mount.
  useEffect(() => {
    if (!supabase) {
      setSub(DEFAULT_SUB);
      return;
    }
    if (workspacesLoading) {
      setSub((s) => ({ ...s, isLoading: true }));
      return;
    }
    let cancelled = false;
    setSub((s) => ({ ...s, isLoading: true }));
    // Pass the active workspace id; get_subscription defaults to personal when
    // omitted, so a null active id (no workspaces) still resolves sensibly.
    const args = activeWorkspaceId ? { p_workspace_id: activeWorkspaceId } : undefined;
    supabase.rpc("get_subscription", args).then(({ data, error }) => {
      if (cancelled) return;
      const row = (Array.isArray(data) ? data[0] : data) as SubscriptionRow | undefined;
      if (error || !row) {
        setSub(DEFAULT_SUB);
        return;
      }
      setSub({
        plan: row.plan,
        usageCount: row.usage_count,
        usageLimit: row.usage_limit,
        canGenerate: row.can_generate,
        workspaceId: row.workspace_id,
        isLoading: false,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, workspacesLoading]);

  const openFn = useCallback(
    async (fn: "create-checkout" | "create-portal", tier?: PaidTier) => {
      // NEVER swallow billing errors — a silent failure reads as a dead button.
      // See .claude/rules/supabase-billing.md.
      setBillingError(null);
      if (!supabase) {
        setBillingError("Billing isn't configured for this build.");
        return;
      }
      if (!sub.workspaceId) {
        setBillingError("Couldn't load your workspace — reopen Settings and try again.");
        return;
      }
      // Owner-only billing (teams epic): the edge fns enforce this with a
      // 403, but surface it client-side too so a Developer sees a clear reason
      // rather than a failed invoke. Personal workspaces are always owner-held.
      if (activeRole && activeRole !== "owner") {
        setBillingError("Only the workspace owner can manage billing.");
        return;
      }
      const what = fn === "create-portal" ? "the billing portal" : "checkout";
      try {
        const { data, error } = await supabase.functions.invoke<{ url?: string }>(fn, {
          body: { workspace_id: sub.workspaceId, email, tier },
        });
        if (error || !data?.url) throw error ?? new Error("No URL returned by the server.");
        window.open(data.url, "_blank");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Failed to invoke ${fn}:`, err);
        setBillingError(`Couldn't open ${what}: ${msg}`);
      }
    },
    [sub.workspaceId, email, activeRole],
  );

  const getToken = useCallback(async () => {
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, []);

  const value = useMemo<AccountValue>(
    () => ({
      ...sub,
      workspaces,
      workspacesLoading,
      activeRole,
      switchWorkspace,
      refreshWorkspaces,
      isDev: false,
      upgrade: (tier?: PaidTier) => openFn("create-checkout", tier),
      manage: () => openFn("create-portal"),
      billingError,
      avatarUrl,
      displayName: name,
      // The account slot bundles the pending-invite bell and the workspace
      // switcher in the chat footer. The Discord avatar/account menu was
      // removed from the chat (poor UX); Sign out now lives in Settings → Profile
      // via the account context's signOut. The switcher's "Manage team" opens the
      // team dialog.
      accountSlot: (
        <>
          <PendingInvitations onAccepted={() => void refreshWorkspaces()} />
          <WorkspaceSwitcher onManageTeam={() => setTeamOpen(true)} />
        </>
      ),
      getToken,
      signOut: async () => {
        await supabase?.auth.signOut();
      },
    }),
    [
      sub,
      openFn,
      avatarUrl,
      name,
      getToken,
      billingError,
      workspaces,
      workspacesLoading,
      activeRole,
      switchWorkspace,
      refreshWorkspaces,
    ],
  );

  return (
    <AccountContext.Provider value={value}>
      {children}
      {/* Team management dialog — mounted once, opened from the switcher. */}
      <TeamManagementDialog open={teamOpen} onOpenChange={setTeamOpen} />
    </AccountContext.Provider>
  );
}

function AuthGate(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  // Hydrate from the persisted (encrypted) session, then track auth-state changes
  // (sign-in via exchangeCodeForSession, token refresh, sign-out). onAuthStateChange
  // is what flips the UI to AppContent the moment the loopback exchange completes.
  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Skeleton className="h-8 w-32 rounded-md" />
      </div>
    );
  }

  if (!session) {
    return <CustomAuth />;
  }

  return (
    <SupabaseAccountProvider key={session.user.id} session={session}>
      <AppContent />
    </SupabaseAccountProvider>
  );
}

export default function AuthApp(): React.JSX.Element {
  return (
    <ActiveThemeProvider>
      <AuthGate />
    </ActiveThemeProvider>
  );
}
