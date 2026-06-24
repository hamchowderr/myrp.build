import { Button } from "@renderer/components/ui/button";
import { useSettingsState } from "@renderer/hooks/useSettingsState";
import { buildLabel } from "@renderer/lib/build-info";
import type { AppSettings, ServerContext } from "@renderer/lib/types";
import {
  ArrowLeft,
  Brain,
  CreditCard,
  GitBranch,
  Palette,
  Settings as SettingsIcon,
  User,
} from "lucide-react";
import { useState } from "react";
import { AIContextSection } from "./settings/AIContextSection";
import { AppearanceSection } from "./settings/AppearanceSection";
import { BackupSection } from "./settings/BackupSection";
import { GeneralSection } from "./settings/GeneralSection";
import { ProfileSection } from "./settings/ProfileSection";
import { SubscriptionSection } from "./settings/SubscriptionSection";

type SettingsSection =
  | "profile"
  | "general"
  | "subscription"
  | "ai-context"
  | "appearance"
  | "backup";

const sidebarNavItems: {
  title: string;
  value: SettingsSection;
  icon: React.ElementType;
}[] = [
  { title: "Profile", value: "profile", icon: User },
  { title: "General", value: "general", icon: SettingsIcon },
  { title: "Subscription", value: "subscription", icon: CreditCard },
  { title: "Backup", value: "backup", icon: GitBranch },
  { title: "AI Context", value: "ai-context", icon: Brain },
  { title: "Appearance", value: "appearance", icon: Palette },
];

export function Settings({
  settings,
  context,
  isDark,
  onToggleTheme,
  onBack,
}: {
  settings: AppSettings;
  context: ServerContext;
  isDark: boolean;
  onToggleTheme: () => void;
  onBack: () => void;
}) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("profile");
  const state = useSettingsState(settings);

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border/50 px-4 py-2.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <span className="text-sm font-semibold tracking-tight">Settings</span>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-52 shrink-0 border-r border-border/40 py-4">
          <nav className="flex flex-col px-2">
            {sidebarNavItems.map((item) => (
              <button
                type="button"
                key={item.value}
                onClick={() => setActiveSection(item.value)}
                className={`group flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs transition-colors ${
                  activeSection === item.value
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <item.icon
                  className={`size-3.5 shrink-0 ${
                    activeSection === item.value
                      ? "text-primary"
                      : "text-muted-foreground group-hover:text-foreground"
                  }`}
                />
                {item.title}
              </button>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl px-8 py-6">
            {activeSection === "profile" && (
              <ProfileSection
                profile={state.profile}
                setProfile={state.setProfile}
                profileSaved={state.profileSaved}
                initials={state.initials}
                onSave={state.handleProfileSave}
              />
            )}

            {activeSection === "general" && (
              <GeneralSection
                settings={settings}
                context={context}
                isChangingPath={state.isChangingPath}
                detectedPaths={state.detectedPaths}
                isScanning={state.isScanning}
                serverPort={state.serverPort}
                setServerPort={state.setServerPort}
                rconPassword={state.rconPassword}
                setRconPassword={state.setRconPassword}
                serverExePath={state.serverExePath}
                setServerExePath={state.setServerExePath}
                connectionSaved={state.connectionSaved}
                rconTestState={state.rconTestState}
                rconTestError={state.rconTestError}
                requireApproval={state.requireApproval}
                onToggleApproval={state.toggleApproval}
                onBrowseFolder={state.handleBrowseFolder}
                onSelectDetectedPath={state.handleSelectDetectedPath}
                onSaveConnection={state.handleSaveConnection}
                onBrowseExe={state.handleBrowseExe}
                onTestRcon={state.handleTestRcon}
                txAdminUrl={state.txAdminUrl}
                setTxAdminUrl={state.setTxAdminUrl}
                txAdminUsername={state.txAdminUsername}
                setTxAdminUsername={state.setTxAdminUsername}
                txAdminPassword={state.txAdminPassword}
                setTxAdminPassword={state.setTxAdminPassword}
                txTestState={state.txTestState}
                txTestError={state.txTestError}
                onTestTxAdmin={state.handleTestTxAdmin}
                txWebviewActive={state.txWebviewActive}
                txWebviewState={state.txWebviewState}
                txWebviewError={state.txWebviewError}
                onTxAdminWebviewLogin={state.handleTxAdminWebviewLogin}
                onTxAdminWebviewLogout={state.handleTxAdminWebviewLogout}
              />
            )}

            {activeSection === "subscription" && <SubscriptionSection />}

            {activeSection === "backup" && <BackupSection settings={settings} />}

            {activeSection === "ai-context" && (
              <AIContextSection
                claudeMdContent={state.claudeMdContent}
                claudeMdLoading={state.claudeMdLoading}
                claudeMdError={state.claudeMdError}
                loadClaudeMd={state.loadClaudeMd}
                isActive={activeSection === "ai-context"}
              />
            )}

            {activeSection === "appearance" && (
              <AppearanceSection isDark={isDark} onToggleTheme={onToggleTheme} />
            )}

            <p className="mt-10 border-t border-border/40 pt-3 text-center font-mono text-[10px] text-muted-foreground/70">
              myRP.build {buildLabel()}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
