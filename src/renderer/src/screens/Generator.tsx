import { AEChat } from "@renderer/components/chat/AEChat";
import { ArtifactPanel } from "@renderer/components/chat/ArtifactPanel";
import { ConversationSidebar } from "@renderer/components/chat/ConversationSidebar";
import { HeaderBar } from "@renderer/components/chat/HeaderBar";
import { ServerStatusControls } from "@renderer/components/chat/ServerStatusControls";
import { useAEChat } from "@renderer/hooks/useAEChat";
import { useServerConsole } from "@renderer/hooks/useServerConsole";
import { useServerProcess } from "@renderer/hooks/useServerProcess";
import { useServerStatus } from "@renderer/hooks/useServerStatus";
import { useAccount } from "@renderer/lib/account";
import { getActiveServer } from "@renderer/lib/server-registry";
import type { AppSettings, ServerContext } from "@renderer/lib/types";
import { useCallback, useRef, useState } from "react";
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
  const {
    messages,
    isGenerating,
    result,
    lastGenerationId,
    canUndo,
    awaitingApproval,
    error,
    followups,
    promptHistory,
    send,
    clearHistory,
    newSession,
    cancel,
    clone,
    sessionId,
    openThread,
    undo,
    clearResult,
  } = useAEChat();

  const { plan, usageCount, usageLimit } = useAccount();
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

  // Whole-server restart via txAdmin REST (fivem-studio-zdy). Unlike Start/Stop
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
        {/* Header Bar */}
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
            <ConversationSidebar
              activeThreadId={sessionId}
              onOpenThread={(id) => void openThread(id)}
              onNewSession={newSession}
              onBranch={() => void clone()}
              refreshSignal={lastGenerationId}
            />
          </Panel>

          <PanelResizeHandle className="group relative w-1.5 transition-colors hover:bg-primary/[0.05]">
            {/* A full-height hairline that blends with the panel borders; it only
                brightens to the accent on hover, signalling it's draggable. */}
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-subtle/50 transition-colors group-hover:bg-primary/40" />
          </PanelResizeHandle>

          <Panel defaultSize={42} minSize={28}>
            <AEChat
              messages={messages}
              isGenerating={isGenerating}
              awaitingApproval={awaitingApproval}
              error={error}
              followups={followups}
              lastGenerationId={lastGenerationId}
              context={context}
              promptHistory={promptHistory}
              canUndo={canUndo}
              onUndo={undo}
              onSend={send}
              onCancel={cancel}
              onClearHistory={clearHistory}
              onOpenSettings={onOpenSettings}
              isDark={isDark}
              onToggleTheme={onToggleTheme}
            />
          </Panel>

          <PanelResizeHandle className="group relative w-1.5 transition-colors hover:bg-primary/[0.05]">
            {/* A full-height hairline that blends with the panel borders; it only
                brightens to the accent on hover, signalling it's draggable. */}
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border-subtle/50 transition-colors group-hover:bg-primary/40" />
          </PanelResizeHandle>

          <Panel defaultSize={42} minSize={25}>
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
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
}
