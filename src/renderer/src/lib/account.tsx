/**
 * Account/subscription context.
 *
 * Decouples the app's consumers (Generator, StatusBar, ChatInput, SubscriptionSection)
 * from Supabase. Consumers read this context via `useAccount()` and NEVER import
 * @supabase — so that lib stays out of the main startup chunk.
 *
 * Two providers supply the value:
 *  - DEV (here): a stub used in the owner's local-testing bypass — unlimited usage,
 *    no billing, no account button. Imports nothing heavy.
 *  - PROD: SupabaseAccountProvider in the lazy AuthApp module wires the real
 *    Supabase Auth user + usage/billing and supplies the account button as
 *    `accountSlot`.
 */
import { createContext, type ReactNode, useContext } from "react";

/** Paid Stripe tiers (Free is the unsubscribed default). */
export type PaidTier = "starter" | "pro" | "studio";
export type Plan = "free" | PaidTier;

/** Workspace roles (teams epic). 'admin' is defunct/never assigned. */
export type WorkspaceRole = "owner" | "developer" | "admin";

/** One workspace the signed-in user belongs to (from list_my_workspaces). */
export interface Workspace {
  workspaceId: string;
  name: string;
  isPersonal: boolean;
  role: WorkspaceRole;
  plan: Plan;
}

export interface AccountValue {
  plan: Plan;
  usageCount: number;
  usageLimit: number;
  canGenerate: boolean;
  /**
   * The ACTIVE workspace id — the single source of truth that downstream
   * consumers (chat generation, billing) read (teams epic). Tracks
   * app_users.active_workspace_id; falls back to the personal workspace.
   */
  workspaceId?: string;
  /** Every workspace the user belongs to, for the switcher. Empty in dev. */
  workspaces: Workspace[];
  /** True while the workspace list is first loading. */
  workspacesLoading: boolean;
  /** The active workspace's role for the current user (gates owner-only UI). */
  activeRole?: WorkspaceRole;
  /** Switch the active workspace (persists app_users.active_workspace_id). No-op in dev. */
  switchWorkspace: (workspaceId: string) => Promise<void>;
  /** Re-pull the workspace list (after create/accept/leave). No-op in dev. */
  refreshWorkspaces: () => Promise<void>;
  /** Discord OAuth avatar URL for the signed-in user (prod). undefined in dev-bypass. */
  avatarUrl?: string;
  /** Discord display name for the signed-in user (prod). undefined in dev-bypass. */
  displayName?: string;
  isLoading: boolean;
  /** True in the dev-bypass build — billing/auth are disabled. */
  isDev: boolean;
  /** Start the upgrade (Stripe Checkout) flow for a tier (default pro). No-op in dev. */
  upgrade: (tier?: PaidTier) => void;
  /** Open the billing portal. No-op in dev. */
  manage: () => void;
  /** Last billing (checkout/portal) failure to surface in the UI; null when clear. */
  billingError: string | null;
  /** Account UI rendered in ChatInput (account button in prod; nothing in dev). */
  accountSlot: ReactNode;
  /** Supabase access token for the prod inference proxy; null in dev-bypass. */
  getToken: () => Promise<string | null>;
  /** Sign out of the prod session (Settings → Profile). No-op in dev-bypass. */
  signOut: () => Promise<void>;
}

/** Dev-bypass value: unlimited, no billing, treated as "pro" so no upgrade nag. */
const DEV_ACCOUNT: AccountValue = {
  plan: "pro",
  usageCount: 0,
  usageLimit: Number.POSITIVE_INFINITY,
  canGenerate: true,
  workspaces: [],
  workspacesLoading: false,
  switchWorkspace: async () => {},
  refreshWorkspaces: async () => {},
  isLoading: false,
  isDev: true,
  upgrade: () => {},
  manage: () => {},
  billingError: null,
  accountSlot: null,
  getToken: async () => null,
  signOut: async () => {},
};

export const AccountContext = createContext<AccountValue>(DEV_ACCOUNT);

/** Read account/subscription state. Safe everywhere — defaults to the dev stub. */
export function useAccount(): AccountValue {
  return useContext(AccountContext);
}

/** Wraps `children` with the dev-bypass account value. */
export function DevAccountProvider({ children }: { children: ReactNode }) {
  return <AccountContext.Provider value={DEV_ACCOUNT}>{children}</AccountContext.Provider>;
}
