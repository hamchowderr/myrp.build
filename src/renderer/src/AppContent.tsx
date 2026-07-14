/**
 * The actual app shell — setup wizard, settings, and the Generator — with screen
 * routing, settings load, theme, and the welcome tour. Deliberately free of any
 * auth/Supabase imports so it renders in BOTH paths: the dev-bypass branch
 * (App.tsx) and, after sign-in, the lazy auth branch (AuthApp.tsx).
 */

import { CommandPalette } from "@renderer/components/CommandPalette";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { TourProvider, useTour } from "@renderer/components/ui/tour";
import { getActiveServer, markOpened } from "@renderer/lib/server-registry";
import { hasSeenTour, markTourSeen, TOURS } from "@renderer/lib/tours";
import type { AppScreen, AppSettings, ServerContext } from "@renderer/lib/types";
import { DeployMonitor } from "@renderer/screens/DeployMonitor";
import { Generator } from "@renderer/screens/Generator";
import { ResourceBrowser } from "@renderer/screens/ResourceBrowser";
import { ServersDashboard } from "@renderer/screens/ServersDashboard";
import { Settings as SettingsScreen } from "@renderer/screens/Settings";
import { Setup } from "@renderer/screens/Setup";
import { useCallback, useEffect, useState } from "react";

export function AppContent(): React.JSX.Element {
  const [currentScreen, setCurrentScreen] = useState<AppScreen>("setup");
  const [previousScreen, setPreviousScreen] = useState<AppScreen>("generator");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [context, setContext] = useState<ServerContext | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDark, setIsDark] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Global Cmd/Ctrl-K toggles the command palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const detectContext = useCallback(async (serverPath: string) => {
    try {
      const ctx = await window.api.detectContext(serverPath);
      setContext(ctx);
      return ctx;
    } catch (err) {
      console.error("Context detection failed:", err);
      return null;
    }
  }, []);

  useEffect(() => {
    async function init() {
      try {
        const loaded = await window.api.loadSettings();
        // Registry has servers → land on the dashboard (context is detected when a
        // server is opened, not up front). First run (no servers) → Setup.
        if (loaded && loaded.servers.length > 0) {
          setSettings(loaded);
          setCurrentScreen("dashboard");
        }
      } catch (err) {
        console.error("Failed to load settings:", err);
      } finally {
        setIsLoading(false);
      }
    }
    init();
  }, []);

  function handleSetupComplete(newSettings: AppSettings) {
    setSettings(newSettings);
    setCurrentScreen("dashboard");
  }

  // Make a server active, stamp lastOpenedAt, persist, and detect its context.
  async function activateServer(id: string): Promise<void> {
    if (!settings) return;
    const next = markOpened(settings, id, Date.now());
    setSettings(next);
    await window.api.saveSettings(next);
    const active = getActiveServer(next);
    if (active) await detectContext(active.serverPath);
  }

  async function handleOpenServer(id: string): Promise<void> {
    await activateServer(id);
    setCurrentScreen("generator");
  }

  async function handleManageServer(id: string): Promise<void> {
    await activateServer(id);
    setPreviousScreen("dashboard");
    setCurrentScreen("settings");
  }

  // Command-palette "Open Settings" — ensures the active server's context is
  // detected first (Settings needs it), preserving the current screen as the
  // back target. Without this, opening Settings from the dashboard (context not
  // yet detected) bounces straight back to the dashboard.
  async function openActiveSettings(): Promise<void> {
    const active = settings ? getActiveServer(settings) : null;
    if (!active) return;
    setPreviousScreen(currentScreen === "settings" ? previousScreen : currentScreen);
    if (!context) await activateServer(active.id);
    setCurrentScreen("settings");
  }

  function openSettings() {
    setPreviousScreen(currentScreen);
    setCurrentScreen("settings");
  }

  function openResources() {
    setPreviousScreen(currentScreen === "resources" ? previousScreen : currentScreen);
    setCurrentScreen("resources");
  }

  function openDeploy() {
    setPreviousScreen(currentScreen === "deploy" ? previousScreen : currentScreen);
    setCurrentScreen("deploy");
  }

  // Dashboard "Deploy" — make the server active first, then open its panel.
  async function handleDeployServer(id: string): Promise<void> {
    if (!settings) return;
    const next = markOpened(settings, id, Date.now());
    setSettings(next);
    await window.api.saveSettings(next);
    setCurrentScreen("deploy");
  }

  function closeSettings() {
    setCurrentScreen(previousScreen);
  }

  // Sync theme class to root
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [isDark]);

  // Sync dark mode to localStorage
  useEffect(() => {
    const stored = localStorage.getItem("myrp-build-dark");
    if (stored !== null) {
      setIsDark(stored === "true");
    }
  }, []);

  function toggleTheme() {
    setIsDark((prev) => {
      const next = !prev;
      localStorage.setItem("myrp-build-dark", String(next));
      return next;
    });
  }

  if (isLoading) {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        {/* Header skeleton */}
        <div className="flex items-center px-2 py-3 border-b border-border/40">
          <div className="flex items-center gap-1.5 ml-2.5">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-4 w-28 rounded" />
          </div>
          <div className="absolute left-1/2 -translate-x-1/2">
            <Skeleton className="h-7 w-48 rounded-md" />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="h-7 w-20 rounded-md" />
            <Skeleton className="h-7 w-7 rounded-md" />
          </div>
        </div>

        {/* Body skeleton — mirrors the Generator split layout */}
        <div className="flex flex-1 min-h-0 gap-2 p-2">
          {/* Left panel (chat) */}
          <div className="flex flex-1 flex-col gap-2 rounded-md border border-border/40 p-3">
            {/* Chat header */}
            <Skeleton className="h-5 w-16 rounded" />
            {/* Message bubbles */}
            <div className="flex flex-col gap-3 flex-1 pt-2">
              <div className="flex flex-col gap-1.5 mr-16">
                <Skeleton className="h-3 w-20 rounded self-start" />
                <Skeleton className="h-10 w-3/4 rounded-md" />
              </div>
              <div className="flex flex-col gap-1.5 ml-16 items-end">
                <Skeleton className="h-3 w-12 rounded self-end" />
                <Skeleton className="h-8 w-1/2 rounded-md" />
              </div>
              <div className="flex flex-col gap-1.5 mr-16">
                <Skeleton className="h-3 w-20 rounded" />
                <Skeleton className="h-20 w-full rounded-md" />
              </div>
            </div>
            {/* Input area */}
            <Skeleton className="h-16 w-full rounded-md mt-auto" />
          </div>

          {/* Right panel group */}
          <div className="flex flex-1 flex-col gap-2">
            {/* Resource info */}
            <div className="flex-[1] rounded-md border border-border/40 p-3 space-y-2">
              <Skeleton className="h-4 w-24 rounded" />
              <Skeleton className="h-3 w-40 rounded" />
              <Skeleton className="h-3 w-32 rounded" />
            </div>
            {/* File explorer */}
            <div className="flex-[2] rounded-md border border-border/40 p-3 space-y-1.5">
              <Skeleton className="h-4 w-20 rounded" />
              <Skeleton className="h-5 w-3/4 rounded" />
              <Skeleton className="h-5 w-2/3 rounded" />
              <Skeleton className="h-5 w-1/2 rounded" />
              <Skeleton className="h-5 w-3/5 rounded" />
            </div>
            {/* Logs */}
            <div className="flex-[1] rounded-md border border-border/40 p-3 space-y-1.5">
              <Skeleton className="h-4 w-16 rounded" />
              <Skeleton className="h-4 w-full rounded" />
              <Skeleton className="h-4 w-4/5 rounded" />
              <Skeleton className="h-4 w-2/3 rounded" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // First run (no registry) or explicit setup → the setup wizard.
  if (!settings || settings.servers.length === 0 || currentScreen === "setup") {
    return (
      <TooltipProvider>
        <Setup onComplete={handleSetupComplete} isDark={isDark} onToggleTheme={toggleTheme} />
      </TooltipProvider>
    );
  }

  const backToDashboard = () => setCurrentScreen("dashboard");

  // Global command palette + the dashboard element are shared across the
  // app-shell screens. settings is non-null past the setup guard above.
  const palette = (
    <CommandPalette
      settings={settings}
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      onGoToDashboard={backToDashboard}
      onOpenServer={handleOpenServer}
      onOpenSettings={openActiveSettings}
      onBrowseResources={openResources}
      onOpenDeploy={openDeploy}
      onToggleTheme={toggleTheme}
    />
  );
  const dashboardEl = (
    <ServersDashboard
      settings={settings}
      onOpenServer={handleOpenServer}
      onManageServer={handleManageServer}
      onDeployServer={handleDeployServer}
      isDark={isDark}
      onToggleTheme={toggleTheme}
    />
  );

  // The landing surface — needs no per-server context (detected on open). Also
  // the fallback when Generator/Settings is requested before context is ready.
  // Resource browser + deploy panel — compose per-server IPC, no context needed.
  if (currentScreen === "resources") {
    return (
      <TooltipProvider>
        <ResourceBrowser settings={settings} onBack={backToDashboard} />
        {palette}
      </TooltipProvider>
    );
  }

  if (currentScreen === "deploy") {
    return (
      <TooltipProvider>
        <DeployMonitor settings={settings} onBack={backToDashboard} />
        {palette}
      </TooltipProvider>
    );
  }

  if (currentScreen === "dashboard" || !context) {
    return (
      <TooltipProvider>
        {dashboardEl}
        {palette}
      </TooltipProvider>
    );
  }

  if (currentScreen === "settings") {
    return (
      <TooltipProvider>
        <SettingsScreen
          settings={settings}
          context={context}
          isDark={isDark}
          onToggleTheme={toggleTheme}
          onBack={closeSettings}
        />
        {palette}
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <TourProvider tours={TOURS}>
        <div className="relative h-screen flex flex-col overflow-hidden bg-background">
          {/* Main content — server status now lives in the header, so there's no
              bottom strip to reserve space for. */}
          <div className="relative flex min-h-0 flex-1 overflow-hidden p-2">
            <Generator
              settings={settings}
              context={context}
              onOpenSettings={openSettings}
              onBackToServers={backToDashboard}
              onBrowseResources={openResources}
              isDark={isDark}
              onToggleTheme={toggleTheme}
            />
          </div>
          <AutoStartTour />
        </div>
      </TourProvider>
      {palette}
    </TooltipProvider>
  );
}

/** Auto-starts the welcome tour on first visit */
function AutoStartTour(): null {
  const tour = useTour();
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount — the welcome tour fires a single time
  useEffect(() => {
    if (!hasSeenTour("welcome")) {
      const timer = setTimeout(() => {
        tour.start("welcome");
        markTourSeen("welcome");
      }, 800);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, []);
  return null;
}
