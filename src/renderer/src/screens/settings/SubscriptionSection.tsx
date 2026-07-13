import { Button } from "@renderer/components/ui/button";
import { Separator } from "@renderer/components/ui/separator";
import { type PaidTier, type Plan, useAccount } from "@renderer/lib/account";
import { CreditCard, ExternalLink, Loader2 } from "lucide-react";
import { SectionHeader, SettingsRow } from "./shared";

const PLAN_LABEL: Record<Plan, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  studio: "Studio",
};

const TIERS: { tier: PaidTier; price: string; gens: string }[] = [
  { tier: "starter", price: "$15/mo", gens: "100 generations" },
  { tier: "pro", price: "$25/mo", gens: "500 generations" },
  { tier: "studio", price: "$60/mo", gens: "2,500 generations" },
];

export function SubscriptionSection() {
  const {
    plan,
    usageCount,
    usageLimit,
    canGenerate,
    workspaceId,
    workspaces,
    activeRole,
    isLoading,
    isDev,
    upgrade,
    manage,
    billingError,
  } = useAccount();

  const usagePercent = usageLimit > 0 ? (usageCount / usageLimit) * 100 : 0;

  // Billing applies to the ACTIVE workspace (teams epic). Only its owner
  // may upgrade/manage; a developer sees the plan read-only. The edge fns also
  // enforce owner-only with a 403 — this is the matching client-side gate.
  const activeWs = workspaces.find((w) => w.workspaceId === workspaceId);
  const canManageBilling = !activeRole || activeRole === "owner";

  const handleUpgrade = upgrade;
  const handleManage = manage;

  // Dev-bypass: billing is disabled (running on the local key) — say so plainly.
  if (isDev) {
    return (
      <div className="space-y-0">
        <SectionHeader title="Subscription" description="Manage your plan and usage." />
        <Separator className="mb-1" />
        <div className="py-6 text-[11px] text-muted-foreground">
          Developer mode — running on a local API key. Billing, usage limits, and sign-in are
          bypassed.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      <SectionHeader title="Subscription" description="Manage your plan and usage." />
      <Separator className="mb-1" />

      {isLoading ? (
        <div className="flex items-center gap-1.5 py-6 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Loading subscription info...
        </div>
      ) : (
        <>
          {activeWs ? (
            <>
              <SettingsRow
                label="Workspace"
                description={
                  activeWs.isPersonal
                    ? "Your personal workspace."
                    : `Team workspace — you are ${activeRole === "owner" ? "the owner" : "a developer"}.`
                }
              >
                <span className="max-w-44 truncate font-mono text-[11px] text-muted-foreground">
                  {activeWs.name}
                </span>
              </SettingsRow>
              <Separator className="opacity-50" />
            </>
          ) : null}

          <SettingsRow label="Current plan" description="This workspace's subscription tier.">
            <div
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 ${
                plan === "free" ? "bg-muted" : "bg-chart-2/10"
              }`}
            >
              <span
                className={`font-mono text-[11px] font-semibold ${
                  plan === "free" ? "text-muted-foreground" : "text-chart-2"
                }`}
              >
                {PLAN_LABEL[plan]}
              </span>
            </div>
          </SettingsRow>
          <Separator className="opacity-50" />

          <SettingsRow
            label="Monthly usage"
            description={`${usageCount} of ${usageLimit} generations used this month.`}
          >
            <div className="flex items-center gap-3">
              <div className="w-32 h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    usagePercent >= 90
                      ? "bg-destructive"
                      : usagePercent >= 70
                        ? "bg-chart-3"
                        : "bg-chart-2"
                  }`}
                  style={{ width: `${Math.min(usagePercent, 100)}%` }}
                />
              </div>
              <span className="font-mono text-[11px] text-muted-foreground">
                {usageCount}/{usageLimit}
              </span>
            </div>
          </SettingsRow>

          {!canGenerate && (
            <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/[0.05] px-3 py-2.5">
              <p className="text-[11px] leading-relaxed text-destructive/80">
                You've reached your monthly generation limit. Upgrade for more generations.
              </p>
            </div>
          )}

          {!canManageBilling ? (
            <div className="mt-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2.5">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Only the workspace owner can change this team's plan. Ask them to upgrade or manage
                billing.
              </p>
            </div>
          ) : plan === "free" ? (
            <div className="grid grid-cols-3 gap-2 py-4">
              {TIERS.map(({ tier, price, gens }) => (
                <div
                  key={tier}
                  className="flex flex-col gap-2 rounded-md border border-border/60 p-3"
                >
                  <div>
                    <div className="text-xs font-semibold">{PLAN_LABEL[tier]}</div>
                    <div className="text-[11px] text-muted-foreground">{price}</div>
                    <div className="text-[11px] text-muted-foreground">{gens}</div>
                  </div>
                  <Button
                    size="sm"
                    className="h-7 text-xs gap-1.5"
                    onClick={() => handleUpgrade(tier)}
                    disabled={!workspaceId}
                  >
                    <CreditCard className="size-3" />
                    Upgrade
                    <ExternalLink className="size-2.5" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 py-4">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1.5"
                onClick={handleManage}
                disabled={!workspaceId}
              >
                Manage Subscription
                <ExternalLink className="size-2.5" />
              </Button>
            </div>
          )}

          {billingError && (
            <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/[0.05] px-3 py-2.5">
              <p className="text-[11px] leading-relaxed text-destructive/80">{billingError}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
