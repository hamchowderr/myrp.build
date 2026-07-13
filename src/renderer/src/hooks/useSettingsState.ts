import { addServer, getActiveServer, upsertActiveServer } from "@renderer/lib/server-registry";
import type { AppSettings } from "@renderer/lib/types";
import { useCallback, useEffect, useState } from "react";

function loadProfile(): { displayName: string } {
  try {
    const stored = localStorage.getItem("myrp-build-profile");
    if (stored) {
      const parsed = JSON.parse(stored);
      return { displayName: parsed.displayName || "Developer" };
    }
  } catch {}
  return { displayName: "Developer" };
}

function saveProfile(profile: { displayName: string }) {
  localStorage.setItem("myrp-build-profile", JSON.stringify(profile));
}

export function useSettingsState(settings: AppSettings) {
  // The active server record backs all per-server connection fields below.
  const activeServer = getActiveServer(settings);

  // Path & scanning
  const [isChangingPath, setIsChangingPath] = useState(false);
  const [detectedPaths, setDetectedPaths] = useState<string[]>([]);
  const [isScanning, setIsScanning] = useState(true);

  // Connection
  const [serverPort, setServerPort] = useState(activeServer?.serverPort?.toString() ?? "30120");
  const [rconPassword, setRconPassword] = useState(activeServer?.rconPassword ?? "");
  const [requireApproval, setRequireApproval] = useState(settings.requireApproval ?? true);

  async function toggleApproval(value: boolean): Promise<void> {
    setRequireApproval(value);
    await window.api.saveSettings({ ...settings, requireApproval: value });
  }
  const [serverExePath, setServerExePath] = useState(activeServer?.serverExePath ?? "");
  const [connectionSaved, setConnectionSaved] = useState(false);
  const [rconTestState, setRconTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [rconTestError, setRconTestError] = useState<string | undefined>();

  // txAdmin REST control (server restart button + resource-manager live controls)
  const [txAdminUrl, setTxAdminUrl] = useState(
    activeServer?.txAdminUrl ?? "http://127.0.0.1:40120",
  );
  const [txAdminUsername, setTxAdminUsername] = useState(activeServer?.txAdminUsername ?? "");
  const [txAdminPassword, setTxAdminPassword] = useState(activeServer?.txAdminPassword ?? "");
  const [txTestState, setTxTestState] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [txTestError, setTxTestError] = useState<string | undefined>();
  // Zero-password webview login: is a harvested session active, and a
  // status line for the login attempt.
  const [txWebviewActive, setTxWebviewActive] = useState(false);
  const [txWebviewState, setTxWebviewState] = useState<"idle" | "opening" | "ok" | "fail">("idle");
  const [txWebviewError, setTxWebviewError] = useState<string | undefined>();

  // Profile
  const [profile, setProfile] = useState(loadProfile);
  const [profileSaved, setProfileSaved] = useState(false);

  // QMD

  // AI Context
  const [claudeMdContent, setClaudeMdContent] = useState<string | null>(null);
  const [claudeMdLoading, setClaudeMdLoading] = useState(false);
  const [claudeMdError, setClaudeMdError] = useState(false);

  const activeServerPath = activeServer?.serverPath;
  const activeServerExePath = activeServer?.serverExePath;

  // Auto-detect FXServer.exe on mount
  useEffect(() => {
    if (!activeServerPath) return;
    const current = activeServerExePath ?? "";
    if (current.toLowerCase().endsWith(".exe")) return;
    window.api
      .findServerExe(activeServerPath)
      .then((found) => {
        if (found) setServerExePath(found);
      })
      .catch(() => {});
  }, [activeServerPath, activeServerExePath]);

  // Scan for other servers
  useEffect(() => {
    async function scan() {
      try {
        const paths = await window.api.findServerPaths();
        setDetectedPaths(paths.filter((p) => p !== activeServerPath));
      } catch (err) {
        console.error("Failed to scan for servers:", err);
      } finally {
        setIsScanning(false);
      }
    }
    scan();
  }, [activeServerPath]);

  // AI Context loader
  const loadClaudeMd = useCallback(async () => {
    if (!activeServerPath) return;
    setClaudeMdLoading(true);
    setClaudeMdError(false);
    try {
      const content = await window.api.readFile(`${activeServerPath}/.claude/CLAUDE.md`);
      setClaudeMdContent(content);
    } catch {
      setClaudeMdContent(null);
      setClaudeMdError(true);
    } finally {
      setClaudeMdLoading(false);
    }
  }, [activeServerPath]);

  // Handlers
  function handleProfileSave() {
    saveProfile(profile);
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2000);
  }

  async function handleSelectDetectedPath(path: string) {
    setIsChangingPath(true);
    try {
      await window.api.detectContext(path);
      // Register-or-select the server (preserves every other server's config).
      const { settings: next } = addServer(settings, path);
      await window.api.saveSettings(next);
      window.location.reload();
    } catch (err) {
      console.error("Failed to switch server:", err);
    } finally {
      setIsChangingPath(false);
    }
  }

  async function handleSaveConnection() {
    const port = parseInt(serverPort, 10);
    // Patch only the active server's record — no other server is touched.
    const next = upsertActiveServer(settings, {
      serverPort: Number.isNaN(port) ? 30120 : port,
      rconPassword: rconPassword || undefined,
      serverExePath: serverExePath || undefined,
      txAdminUrl: txAdminUrl.trim() || undefined,
      txAdminUsername: txAdminUsername.trim() || undefined,
      txAdminPassword: txAdminPassword || undefined,
    });
    await window.api.saveSettings(next);
    setConnectionSaved(true);
    setTimeout(() => setConnectionSaved(false), 2000);
  }

  // Persist creds, then validate them against the live txAdmin (server-side).
  async function handleTestTxAdmin() {
    if (!txAdminUsername.trim() || !txAdminPassword) {
      setTxTestState("fail");
      setTxTestError("Enter txAdmin username and password first.");
      setTimeout(() => setTxTestState("idle"), 4000);
      return;
    }
    await handleSaveConnection();
    setTxTestState("testing");
    setTxTestError(undefined);
    const result = await window.api.txadmin.testConnection();
    setTxTestState(result.ok ? "ok" : "fail");
    setTxTestError(result.ok ? undefined : result.error);
    setTimeout(() => setTxTestState("idle"), 4000);
  }

  // Reflect any already-active harvested session on mount.
  useEffect(() => {
    window.api.txadmin
      .hasWebviewSession()
      .then((r) => setTxWebviewActive(r.active))
      .catch(() => {});
  }, []);

  // Open the txAdmin panel for a zero-password (Cfx.re) login, then harvest.
  async function handleTxAdminWebviewLogin() {
    // Persist the URL first so the main process opens the right panel.
    await handleSaveConnection();
    setTxWebviewState("opening");
    setTxWebviewError(undefined);
    try {
      const result = await window.api.txadmin.webviewLogin();
      if (result.ok) {
        setTxWebviewState("ok");
        setTxWebviewActive(true);
      } else {
        setTxWebviewState(result.cancelled ? "idle" : "fail");
        setTxWebviewError(result.cancelled ? undefined : result.error);
      }
    } catch (err) {
      setTxWebviewState("fail");
      setTxWebviewError(err instanceof Error ? err.message : String(err));
    }
    setTimeout(() => setTxWebviewState((s) => (s === "fail" ? "idle" : s)), 5000);
  }

  // Sign out of the harvested session (reverts to password fallback).
  async function handleTxAdminWebviewLogout() {
    await window.api.txadmin.webviewLogout();
    setTxWebviewActive(false);
    setTxWebviewState("idle");
  }

  async function handleBrowseExe() {
    const path = await window.api.selectFile();
    if (path) setServerExePath(path);
  }

  async function handleTestRcon() {
    const port = parseInt(serverPort, 10);
    if (!rconPassword) {
      setRconTestState("fail");
      setRconTestError("Enter an RCON password first.");
      return;
    }
    setRconTestState("testing");
    setRconTestError(undefined);
    const result = await window.api.testRcon(Number.isNaN(port) ? 30120 : port, rconPassword);
    setRconTestState(result.ok ? "ok" : "fail");
    setRconTestError(result.error);
    setTimeout(() => setRconTestState("idle"), 4000);
  }

  async function handleBrowseFolder() {
    setIsChangingPath(true);
    try {
      const path = await window.api.selectFolder();
      if (path) {
        await window.api.detectContext(path);
        // Register-or-select (preserves every other server's config).
        const { settings: next } = addServer(settings, path);
        await window.api.saveSettings(next);
        window.location.reload();
      }
    } catch (err) {
      console.error("Failed to change server path:", err);
    } finally {
      setIsChangingPath(false);
    }
  }

  const initials = profile.displayName
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return {
    // Path & scanning
    isChangingPath,
    detectedPaths,
    isScanning,
    // Connection
    serverPort,
    setServerPort,
    rconPassword,
    setRconPassword,
    serverExePath,
    setServerExePath,
    connectionSaved,
    rconTestState,
    rconTestError,
    // txAdmin control
    txAdminUrl,
    setTxAdminUrl,
    txAdminUsername,
    setTxAdminUsername,
    txAdminPassword,
    setTxAdminPassword,
    txTestState,
    txTestError,
    handleTestTxAdmin,
    // txAdmin zero-password webview login
    txWebviewActive,
    txWebviewState,
    txWebviewError,
    handleTxAdminWebviewLogin,
    handleTxAdminWebviewLogout,
    // Profile
    profile,
    setProfile,
    profileSaved,
    initials,
    // AI Context
    claudeMdContent,
    claudeMdLoading,
    claudeMdError,
    loadClaudeMd,
    // Handlers
    handleProfileSave,
    handleSelectDetectedPath,
    requireApproval,
    toggleApproval,
    handleSaveConnection,
    handleBrowseExe,
    handleTestRcon,
    handleBrowseFolder,
  };
}

export type SettingsState = ReturnType<typeof useSettingsState>;
