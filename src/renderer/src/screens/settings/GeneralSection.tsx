import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Separator } from "@renderer/components/ui/separator";
import { Toggle } from "@renderer/components/ui/toggle";
import type { SettingsState } from "@renderer/hooks/useSettingsState";
import { getActiveServer } from "@renderer/lib/server-registry";
import type { AppSettings, ServerContext } from "@renderer/lib/types";
import { CheckCircle2, Code, FolderOpen, Loader2, Server, XCircle } from "lucide-react";
import { SectionHeader, SettingsRow, StatusBadge } from "./shared";

interface GeneralSectionProps {
  settings: AppSettings;
  context: ServerContext;
  isChangingPath: boolean;
  detectedPaths: string[];
  isScanning: boolean;
  serverPort: string;
  setServerPort: (v: string) => void;
  rconPassword: string;
  setRconPassword: (v: string) => void;
  serverExePath: string;
  setServerExePath: (v: string) => void;
  connectionSaved: boolean;
  rconTestState: SettingsState["rconTestState"];
  rconTestError: string | undefined;
  requireApproval: boolean;
  onToggleApproval: (value: boolean) => void;
  onBrowseFolder: () => void;
  onSelectDetectedPath: (path: string) => void;
  onSaveConnection: () => void;
  onBrowseExe: () => void;
  onTestRcon: () => void;
  txAdminUrl: string;
  setTxAdminUrl: (v: string) => void;
  txAdminUsername: string;
  setTxAdminUsername: (v: string) => void;
  txAdminPassword: string;
  setTxAdminPassword: (v: string) => void;
  txTestState: SettingsState["txTestState"];
  txTestError: string | undefined;
  onTestTxAdmin: () => void;
  txWebviewActive: boolean;
  txWebviewState: SettingsState["txWebviewState"];
  txWebviewError: string | undefined;
  onTxAdminWebviewLogin: () => void;
  onTxAdminWebviewLogout: () => void;
}

export function GeneralSection({
  settings,
  context,
  isChangingPath,
  detectedPaths,
  isScanning,
  serverPort,
  setServerPort,
  rconPassword,
  setRconPassword,
  serverExePath,
  setServerExePath,
  connectionSaved,
  rconTestState,
  rconTestError,
  requireApproval,
  onToggleApproval,
  onBrowseFolder,
  onSelectDetectedPath,
  onSaveConnection,
  onBrowseExe,
  onTestRcon,
  txAdminUrl,
  setTxAdminUrl,
  txAdminUsername,
  setTxAdminUsername,
  txAdminPassword,
  setTxAdminPassword,
  txTestState,
  txTestError,
  onTestTxAdmin,
  txWebviewActive,
  txWebviewState,
  txWebviewError,
  onTxAdminWebviewLogin,
  onTxAdminWebviewLogout,
}: GeneralSectionProps) {
  const hasUnknowns =
    context.framework === "unknown" ||
    context.dbDriver === "unknown" ||
    context.inventory === "unknown";

  return (
    <div className="space-y-0">
      {/* Server folder */}
      <SectionHeader title="Server folder" />
      <Separator className="mb-1" />

      <div className="py-3 space-y-2.5">
        <div className="flex items-center justify-between rounded-md border border-border/60 bg-muted/30 px-3 py-2">
          <span className="truncate font-mono text-[11px] text-muted-foreground flex-1 mr-3">
            {getActiveServer(settings)?.serverPath}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 shrink-0 gap-1.5 text-[11px]"
            onClick={onBrowseFolder}
            disabled={isChangingPath}
          >
            {isChangingPath ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <FolderOpen className="size-3" />
            )}
            Browse
          </Button>
        </div>

        {isScanning ? (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Scanning for other servers...
          </div>
        ) : detectedPaths.length > 0 ? (
          <div className="space-y-1">
            <p className="text-[11px] text-muted-foreground">
              {detectedPaths.length} other server
              {detectedPaths.length > 1 ? "s" : ""} detected
            </p>
            {detectedPaths.map((p) => (
              <button
                type="button"
                key={p}
                onClick={() => onSelectDetectedPath(p)}
                disabled={isChangingPath}
                className="flex w-full items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-1.5 text-left transition-colors hover:bg-primary/10 hover:border-primary/30 disabled:opacity-50"
              >
                <Server className="size-3 shrink-0 text-primary/60" />
                <span className="truncate font-mono text-[11px] text-foreground/70">{p}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Detected configuration */}
      <div className="pt-4">
        <SectionHeader title="Detected configuration" />
        <Separator className="mb-1" />
      </div>

      <SettingsRow label="Framework" description="Detected from server.cfg ensure lines.">
        <StatusBadge value={context.framework} isUnknown={context.framework === "unknown"} />
      </SettingsRow>
      <Separator className="opacity-50" />

      <SettingsRow label="Database driver" description="MySQL/ORM driver in use.">
        <StatusBadge value={context.dbDriver} isUnknown={context.dbDriver === "unknown"} />
      </SettingsRow>
      <Separator className="opacity-50" />

      <SettingsRow label="Inventory" description="Inventory system resource.">
        <StatusBadge value={context.inventory} isUnknown={context.inventory === "unknown"} />
      </SettingsRow>
      <Separator className="opacity-50" />

      <SettingsRow label="Game build" description="Server game build version.">
        <StatusBadge value={context.gameBuild} isUnknown={context.gameBuild === "unknown"} />
      </SettingsRow>
      <Separator className="opacity-50" />

      <SettingsRow label="Resources in [local]" description="Scripts managed by myRP.build.">
        <div className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5">
          <Code className="size-2.5 text-muted-foreground" />
          <span className="font-mono text-[11px] text-foreground">
            {context.existingResources.length}
          </span>
        </div>
      </SettingsRow>

      {hasUnknowns && (
        <div className="mt-2 rounded-md border border-chart-3/20 bg-chart-3/[0.05] px-3 py-2.5">
          <p className="text-[11px] leading-relaxed text-chart-3/70">
            Add <span className="font-mono font-medium text-chart-3/90">ensure</span> lines to
            server.cfg to enable detection (e.g.{" "}
            <span className="font-mono text-chart-3/90">ensure ox_core</span>
            ). Standalone code is generated until a framework is detected.
          </p>
        </div>
      )}

      {/* Server connection */}
      <div className="pt-4">
        <SectionHeader title="Server connection" />
        <Separator className="mb-1" />
      </div>

      <SettingsRow
        label="HTTP port"
        description="FiveM default is 30120. Used for live status checks."
      >
        <Input
          value={serverPort}
          onChange={(e) => setServerPort(e.target.value)}
          placeholder="30120"
          className="h-7 w-28 text-xs font-mono"
          type="number"
          min={1}
          max={65535}
        />
      </SettingsRow>
      <Separator className="opacity-50" />

      <SettingsRow
        label="RCON password"
        description={
          <>
            Required for the Restart button. Set via{" "}
            <span className="font-mono">rcon_password</span> in server.cfg.
          </>
        }
      >
        <Input
          value={rconPassword}
          onChange={(e) => setRconPassword(e.target.value)}
          placeholder="rcon_password"
          className="h-7 w-40 text-xs font-mono"
          type="password"
        />
      </SettingsRow>
      <Separator className="opacity-50" />

      <SettingsRow
        label="FXServer executable"
        description="Path to FXServer.exe for the Start/Stop button."
      >
        <div className="flex items-center gap-2">
          <Input
            value={serverExePath}
            onChange={(e) => setServerExePath(e.target.value)}
            placeholder="C:\FXServer\server\FXServer.exe"
            className="h-7 w-52 text-xs font-mono"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1.5 text-[11px]"
            onClick={onBrowseExe}
          >
            <FolderOpen className="size-3" />
            Browse
          </Button>
        </div>
      </SettingsRow>

      <div className="flex items-center gap-2 py-3">
        <Button
          size="sm"
          variant={connectionSaved ? "ghost" : "default"}
          className="h-7 text-xs gap-1"
          onClick={onSaveConnection}
        >
          {connectionSaved ? (
            <>
              <CheckCircle2 className="size-3 text-chart-2" />
              <span className="text-chart-2">Saved</span>
            </>
          ) : (
            "Save connection"
          )}
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1"
          onClick={onTestRcon}
          disabled={rconTestState === "testing"}
        >
          {rconTestState === "testing" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : rconTestState === "ok" ? (
            <CheckCircle2 className="size-3 text-chart-2" />
          ) : rconTestState === "fail" ? (
            <XCircle className="size-3 text-destructive" />
          ) : null}
          {rconTestState === "idle"
            ? "Test RCON"
            : rconTestState === "testing"
              ? "Testing..."
              : rconTestState === "ok"
                ? "Connected"
                : "Failed"}
        </Button>

        {rconTestState === "fail" && rconTestError && (
          <span className="text-[11px] text-destructive">{rconTestError}</span>
        )}
      </div>

      {/* txAdmin control */}
      <div className="pt-4">
        <SectionHeader title="txAdmin control" />
        <Separator className="mb-1" />
      </div>

      <SettingsRow
        label="txAdmin URL"
        description="txAdmin web panel — local default http://127.0.0.1:40120. Powers the server Restart button and per-resource controls."
      >
        <Input
          value={txAdminUrl}
          onChange={(e) => setTxAdminUrl(e.target.value)}
          placeholder="http://127.0.0.1:40120"
          className="h-7 w-52 text-xs font-mono"
        />
      </SettingsRow>
      <Separator className="opacity-50" />

      <SettingsRow label="txAdmin username" description="Your txAdmin admin username.">
        <Input
          value={txAdminUsername}
          onChange={(e) => setTxAdminUsername(e.target.value)}
          placeholder="admin"
          className="h-7 w-40 text-xs font-mono"
        />
      </SettingsRow>
      <Separator className="opacity-50" />

      <SettingsRow
        label="txAdmin password"
        description="Optional fallback. Your numeric txAdmin backup password (authenticates the REST API). Not needed once you sign in via Cfx.re below."
      >
        <Input
          value={txAdminPassword}
          onChange={(e) => setTxAdminPassword(e.target.value)}
          placeholder="backup password"
          className="h-7 w-40 text-xs font-mono"
          type="password"
        />
      </SettingsRow>

      <div className="flex items-center gap-2 py-3">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1"
          onClick={onTestTxAdmin}
          disabled={txTestState === "testing"}
        >
          {txTestState === "testing" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : txTestState === "ok" ? (
            <CheckCircle2 className="size-3 text-chart-2" />
          ) : txTestState === "fail" ? (
            <XCircle className="size-3 text-destructive" />
          ) : null}
          {txTestState === "idle"
            ? "Save & test txAdmin"
            : txTestState === "testing"
              ? "Testing..."
              : txTestState === "ok"
                ? "Connected"
                : "Failed"}
        </Button>
        {txTestState === "fail" && txTestError && (
          <span className="text-[11px] text-destructive">{txTestError}</span>
        )}
      </div>

      {/* Zero-password Cfx.re login (dt2) */}
      <SettingsRow
        label="Sign in with Cfx.re"
        description="Log into txAdmin once in a pop-up window (Cfx.re SSO) — myRP.build reuses that session, so no backup password needs to be stored."
      >
        {txWebviewActive ? (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1 text-[11px] text-chart-2">
              <CheckCircle2 className="size-3" /> Signed in
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={onTxAdminWebviewLogout}
            >
              Sign out
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={onTxAdminWebviewLogin}
            disabled={txWebviewState === "opening"}
          >
            {txWebviewState === "opening" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : txWebviewState === "fail" ? (
              <XCircle className="size-3 text-destructive" />
            ) : null}
            {txWebviewState === "opening" ? "Waiting for sign-in..." : "Sign in to txAdmin"}
          </Button>
        )}
      </SettingsRow>
      {txWebviewState === "fail" && txWebviewError && (
        <span className="block pb-2 text-[11px] text-destructive">{txWebviewError}</span>
      )}

      {/* AI safety */}
      <div className="pt-4">
        <SectionHeader title="AI safety" />
        <Separator className="mb-1" />
      </div>

      <SettingsRow
        label="Require approval for sensitive actions"
        description="When on, the agent pauses for your approval before running shell commands or deleting files. File writes always happen instantly."
      >
        <Toggle
          size="sm"
          pressed={requireApproval}
          onPressedChange={onToggleApproval}
          className="h-7 px-3 text-[11px] data-[state=on]:bg-chart-2/20 data-[state=on]:text-chart-2"
        >
          {requireApproval ? "On" : "Off"}
        </Toggle>
      </SettingsRow>
    </div>
  );
}
