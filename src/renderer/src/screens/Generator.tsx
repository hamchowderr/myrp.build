import { ArtifactPanel } from "@renderer/components/chat/ArtifactPanel";
import { ConversationSidebar } from "@renderer/components/chat/ConversationSidebar";
import { HarnessChat } from "@renderer/components/chat/HarnessChat";
import { HeaderBar } from "@renderer/components/chat/HeaderBar";
import { ServerStatusControls } from "@renderer/components/chat/ServerStatusControls";
import { useGenerationResult } from "@renderer/hooks/useGenerationResult";
import { useServerConsole } from "@renderer/hooks/useServerConsole";
import { useServerProcess } from "@renderer/hooks/useServerProcess";
import { useServerStatus } from "@renderer/hooks/useServerStatus";
import { useAccount } from "@renderer/lib/account";
import { useHarnessChat } from "@renderer/lib/harness/use-harness-chat";
import { getActiveServer } from "@renderer/lib/server-registry";
import type { AppSettings, ServerContext } from "@renderer/lib/types";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ImperativePanelHandle,
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { toast } from "sonner";

interface GeneratorProps {
  settings: AppSettings;
  context: ServerContext;
  onOpenSettings: () => void;
  onBackToServers: () => void;
  onBrowseResources: () => void;
  isDark: boolean;
  onToggleTheme: () => void;
}

export function Generator({
  settings,
  context,
  onOpenSettings,
  onBackToServers,
  onBrowseResources,
  isDark,
  onToggleTheme,
}: GeneratorProps) {
  const activeServer = getActiveServer(settings);
  // Click-to-toggle the conversation sidebar (so it isn't drag-only to reopen).
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const toggleSidebar = useCallback(() => {
    const p = sidebarPanelRef.current;
    if (!p) return;
    if (p.isCollapsed()) p.expand();
    else p.collapse();
  }, []);
  // The chat hook is lifted here (not inside HarnessChat) so the sidebar and the
  // header — siblings of the chat panel — can read its thread id and status too.
  const harness = useHarnessChat();
  // Generation output (manifest + undo). Separate from the transcript on purpose:
  // a result outlives the turn that produced it. See useGenerationResult.
  const { result, canUndo, undo, clearResult, resultCount } = useGenerationResult();
  // Drives the header spinner and the artifact panel's busy state. Previously read
  // from the retired useChat transport, which no longer streams — so this was
  // stuck false for every real generation.
  const isGenerating = harness.status === "streaming";

  // Upstream failures main reports outside the harness event stream — no active
  // server, and friendlyLlmError (out of credits / bad key / rate limit). The
  // retired chat hook subscribed to these but rendered them into a component that
  // never mounted, so they were silently swallowed. A toast is not the final home
  // for them, but it is the difference between seeing "out of credits" and seeing
  // nothing at all.
  useEffect(() => window.api.chat.onError((message) => toast.error(message)), []);

  const { plan, usageCount, usageLimit, getToken, workspaceId } = useAccount();

  // Open a past conversation: fetch history (auth like the send path — dev-bypass
  // resolves the seeded token when absent) and seed the transcript.
  const openHarnessThread = useCallback(
    async (id: string) => {
      const accessToken = (await getToken().catch(() => null)) ?? undefined;
      await harness.openThread(id, {
        ...(accessToken ? { accessToken } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      });
    },
    [harness, getToken, workspaceId],
  );

  // Branch the active conversation: copy it server-side, then open the copy so the
  // agent keeps the prior context. This used to run against the retired useChat's
  // message array, which is always empty — so `clone` hit its own
  // `messages.length === 0` guard and the button silently did nothing.
  const branchThread = useCallback(async () => {
    const sourceThreadId = harness.threadId;
    if (!sourceThreadId || harness.status === "streaming") return;
    const accessToken = (await getToken().catch(() => null)) ?? undefined;
    const newThreadId = crypto.randomUUID();
    const res = await window.api.chat.clone({
      sourceThreadId,
      newThreadId,
      accessToken,
      ...(workspaceId ? { workspaceId } : {}),
    });
    if (!res.ok) {
      toast.error(res.error ?? "Couldn't branch this conversation.");
      return;
    }
    await openHarnessThread(newThreadId);
  }, [harness.threadId, harness.status, getToken, workspaceId, openHarnessThread]);
  const { processStatus, refresh: refreshProcess } = useServerProcess();
  const { serverStatus, restartResource } = useServerStatus(processStatus?.running);
  const { entries: consoleEntries, clear: clearConsole } = useServerConsole();
  const [isRestartingServer, setIsRestartingServer] = useState(false);
  const handleStartServer = useCallback(async () => {
    const result = await window.api.startServer();
    if (!result.ok) {
      toast.error(result.error ?? "Failed to start FXServer");
    } else {
      // Poll sooner after start
      setTimeout(refreshProcess, 2000);
    }
  }, [refreshProcess]);

  const handleStopServer = useCallback(async () => {
    const result = await window.api.stopServer();
    if (!result.ok) {
      toast.error(result.error ?? "Failed to stop FXServer");
    } else {
      setTimeout(refreshProcess, 2000);
    }
  }, [refreshProcess]);

  // Whole-server restart via txAdmin REST. Unlike Start/Stop
  // (which drive the local FXServer process directly), this asks txAdmin to cycle
  // the server it manages — same path that works against the cloud Docker txAdmin.
  const handleRestartServer = useCallback(async () => {
    setIsRestartingServer(true);
    const result = await window.api.txadmin.control("restart");
    if (!result.ok) {
      toast.error(result.error ?? "Failed to restart via txAdmin");
    }
    setTimeout(refreshProcess, 3000);
    setTimeout(() => setIsRestartingServer(false), 4000);
  }, [refreshProcess]);

  return (
    <div className="hidden min-h-0 w-full flex-1 overflow-hidden md:flex">
      <div className="flex h-full w-full flex-col">
        {/* Header Bar — flat top bar on the canvas (variation A) */}
        <HeaderBar
          isGenerating={isGenerating}
          settings={settings}
          onBackToServers={onBackToServers}
          onBrowseResources={onBrowseResources}
          onToggleSidebar={toggleSidebar}
          right={
            <ServerStatusControls
              framework={context.framework}
              canUndo={canUndo}
              onUndo={undo}
              serverStatus={serverStatus}
              processStatus={processStatus}
              onStartServer={handleStartServer}
              onStopServer={handleStopServer}
              onRestartServer={handleRestartServer}
              isRestartingServer={isRestartingServer}
              plan={plan}
              usageCount={usageCount}
              usageLimit={usageLimit}
              onUpgrade={onOpenSettings}
            />
          }
        />

        {/* 50/50 resizable split: Chat | Artifact */}
        <PanelGroup direction="horizontal" className="min-h-0 flex-1">
          <Panel ref={sidebarPanelRef} defaultSize={16} minSize={12} maxSize={26} collapsible>
            <div className="flex h-full flex-col bg-background">
              <div className="m-1.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-subtle/50 bg-card shadow-md">
                <ConversationSidebar
                  activeThreadId={harness.threadId ?? ""}
                  onOpenThread={(id) => void openHarnessThread(id)}
                  onNewSession={harness.reset}
                  onBranch={() => void branchThread()}
                  refreshSignal={String(resultCount)}
                />
              </div>
            </div>
          </Panel>

          <PanelResizeHandle className="group relative w-1 transition-colors">
            {/* Cards carry their own border + margin gap now, so the handle is a
                transparent drag strip; a short accent line appears only on hover. */}
            <div className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 rounded-full bg-transparent transition-colors group-hover:bg-primary/40" />
          </PanelResizeHandle>

          <Panel defaultSize={42} minSize={28}>
            <div className="flex h-full flex-col bg-background">
              <div className="m-1.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-subtle/50 bg-card shadow-md">
                <HarnessChat
                  chat={harness}
                  context={context}
                  onOpenSettings={onOpenSettings}
                  isDark={isDark}
                  onToggleTheme={onToggleTheme}
                />
              </div>
            </div>
          </Panel>

          <PanelResizeHandle className="group relative w-1 transition-colors">
            {/* Cards carry their own border + margin gap now, so the handle is a
                transparent drag strip; a short accent line appears only on hover. */}
            <div className="absolute inset-y-2 left-1/2 w-px -translate-x-1/2 rounded-full bg-transparent transition-colors group-hover:bg-primary/40" />
          </PanelResizeHandle>

          <Panel defaultSize={42} minSize={25}>
            <div className="flex h-full flex-col bg-background">
              <div className="m-1.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-subtle/50 bg-card shadow-md">
                <ArtifactPanel
                  lastResult={result}
                  canUndo={canUndo}
                  onUndo={undo}
                  onDeleteResource={(name) => {
                    if (result?.resourceName === name) clearResult();
                  }}
                  toolLog={[]}
                  isGenerating={isGenerating}
                  localPath={activeServer?.localPath ?? ""}
                  serverCfgPath={context.serverCfgPath}
                  serverStatus={serverStatus}
                  onRestart={restartResource}
                  consoleEntries={consoleEntries}
                  onClearConsole={clearConsole}
                />
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}
