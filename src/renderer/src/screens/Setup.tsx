import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@renderer/components/ui/card";
import { Separator } from "@renderer/components/ui/separator";
import { addServer, deriveServerName, emptySettings } from "@renderer/lib/server-registry";
import type { AppSettings } from "@renderer/lib/types";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Circle,
  FolderOpen,
  Loader2,
  Moon,
  Search,
  Server,
  Sun,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";

/** Friendly name from a server path (shared with the registry). */
const extractServerName = deriveServerName;

interface SetupProps {
  onComplete: (settings: AppSettings) => void;
  isDark: boolean;
  onToggleTheme: () => void;
}

export function Setup({ onComplete, isDark, onToggleTheme }: SetupProps) {
  const [serverPath, setServerPath] = useState<string | null>(null);
  const [detectedPaths, setDetectedPaths] = useState<string[]>([]);
  const [isScanning, setIsScanning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    async function scan() {
      try {
        const paths = await window.api.findServerPaths();
        setDetectedPaths(paths);
        if (paths.length === 1) {
          setServerPath(paths[0]);
        }
      } catch {
        // Scan failed silently
      } finally {
        setIsScanning(false);
      }
    }
    scan();
  }, []);

  async function handleBrowse() {
    setError(null);
    const path = await window.api.selectFolder();
    if (path) {
      setServerPath(path);
    }
  }

  async function handleContinue() {
    if (!serverPath) return;
    setIsSaving(true);
    setError(null);

    try {
      await window.api.detectContext(serverPath);
      const serverExePath = (await window.api.findServerExe(serverPath)) ?? undefined;
      // Register the server into the existing registry (don't clobber any other
      // configured servers); make it active.
      const current = (await window.api.loadSettings()) ?? emptySettings();
      const { settings } = addServer(current, serverPath, { serverExePath });
      await window.api.saveSettings(settings);

      onComplete(settings);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not detect a valid FiveM server at this path. Make sure it contains server.cfg.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  const isManualPath = serverPath && !detectedPaths.includes(serverPath);

  return (
    <div className="relative flex h-screen items-center justify-center overflow-hidden">
      {/* Background atmosphere */}
      <div className="pointer-events-none absolute inset-0 dot-grid opacity-40" />
      <div className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 h-[500px] w-[800px] rounded-full bg-primary/[0.04] blur-[100px]" />

      {/* Theme toggle */}
      <Button
        variant="ghost"
        size="sm"
        className="absolute right-4 top-4 h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
        onClick={onToggleTheme}
      >
        {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </Button>

      <div className="relative w-full max-w-md px-6">
        <Card className="relative border-border/60 bg-card/90 shadow-2xl backdrop-blur-sm overflow-hidden">
          {/* Top accent line */}
          <div className="h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent" />

          <CardHeader className="pt-10 pb-2 text-center">
            {/* Logo */}
            <div className="mx-auto mb-5 relative w-fit">
              <div className="flex size-14 items-center justify-center rounded-xl border border-primary/25 bg-primary/10">
                <Zap className="size-7 text-primary" />
              </div>
              <div className="absolute -inset-2 rounded-xl bg-primary/10 blur-xl -z-10" />
            </div>
            <div className="flex items-center justify-center gap-2.5 mb-1">
              <CardTitle className="text-2xl font-bold tracking-tight">myRP.build</CardTitle>
              <Badge
                variant="secondary"
                className="font-mono text-[9px] font-medium tracking-wider px-1.5 py-0"
              >
                v0.1
              </Badge>
            </div>
            <CardDescription>AI-powered resource generator for FiveM servers</CardDescription>
          </CardHeader>

          <CardContent className="space-y-5 pb-8">
            {/* Auto-detected servers */}
            {isScanning ? (
              <div className="space-y-2.5">
                {[1, 2].map((i) => (
                  <div
                    key={i}
                    className="animate-pulse rounded-lg border border-border/40 bg-muted/30 p-3.5"
                  >
                    <div className="flex items-center gap-3">
                      {/* Icon box skeleton */}
                      <div className="size-9 shrink-0 rounded-lg bg-muted/60" />
                      {/* Text lines skeleton */}
                      <div className="flex-1 space-y-2">
                        <div className="h-3.5 w-28 rounded bg-muted/60" />
                        <div className="h-2.5 w-44 rounded bg-muted/40" />
                      </div>
                      {/* Indicator skeleton */}
                      <div className="size-5 shrink-0 rounded-full bg-muted/50" />
                    </div>
                  </div>
                ))}
                <div className="flex items-center justify-center gap-2 pt-1 text-xs text-muted-foreground">
                  <Search className="size-3.5 animate-pulse" />
                  Scanning for FiveM servers...
                </div>
              </div>
            ) : detectedPaths.length > 0 ? (
              <div className="space-y-2.5">
                <p className="font-mono text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                  {detectedPaths.length === 1
                    ? "Server found"
                    : `${detectedPaths.length} servers found`}
                </p>
                <div className="space-y-2">
                  {detectedPaths.map((path) => {
                    const name = extractServerName(path);
                    const isSelected = serverPath === path;
                    return (
                      <button
                        type="button"
                        key={path}
                        className={`group flex w-full items-center gap-3 rounded-lg border p-3.5 text-left transition-all duration-200 cursor-pointer ${
                          isSelected
                            ? "border-primary/40 bg-primary/[0.06]"
                            : "border-border/40 bg-muted/20 hover:border-border/60 hover:bg-muted/30"
                        }`}
                        onClick={() => setServerPath(path)}
                      >
                        <div
                          className={`flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                            isSelected
                              ? "bg-primary/15 text-primary"
                              : "bg-muted/50 text-muted-foreground group-hover:bg-muted"
                          }`}
                        >
                          <Server className="size-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{name}</div>
                          <div className="truncate font-mono text-[10px] text-muted-foreground">
                            {path}
                          </div>
                        </div>
                        {isSelected ? (
                          <CheckCircle2 className="size-5 shrink-0 text-primary" />
                        ) : (
                          <Circle className="size-5 shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground/50" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <div className="flex size-14 items-center justify-center rounded-xl border border-border/40 bg-muted/30">
                  <Server className="size-6 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">No servers found</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Point myRP.build to your server folder to get started.
                  </p>
                </div>
              </div>
            )}

            <Separator className="opacity-50" />

            {/* Manual browse — show success row when a manual path is selected */}
            {isManualPath ? (
              <div className="space-y-2">
                <div className="flex w-full items-center gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/[0.06] p-3.5">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-500">
                    <FolderOpen className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">
                      {extractServerName(serverPath)}
                    </div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">
                      {serverPath}
                    </div>
                  </div>
                  <CheckCircle2 className="size-5 shrink-0 text-emerald-500" />
                </div>
                <Button
                  variant="outline"
                  className="w-full justify-start gap-2.5 text-muted-foreground hover:text-foreground"
                  onClick={handleBrowse}
                >
                  <FolderOpen className="size-4" />
                  Browse folder...
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                className="w-full justify-start gap-2.5 text-muted-foreground hover:text-foreground"
                onClick={handleBrowse}
              >
                <FolderOpen className="size-4" />
                Browse folder...
              </Button>
            )}

            {error && (
              <div className="flex items-start gap-2.5 rounded-lg bg-destructive/10 border border-destructive/25 p-3 text-destructive">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span className="text-xs leading-relaxed">{error}</span>
              </div>
            )}

            <Button
              className="h-11 w-full gap-2 font-semibold"
              disabled={!serverPath || isSaving}
              onClick={handleContinue}
            >
              {isSaving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Detecting...
                </>
              ) : (
                <>
                  Get started
                  <ArrowRight className="size-4" />
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
