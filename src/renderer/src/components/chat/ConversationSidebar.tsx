/**
 * Conversation history sidebar (eh2g #3/#4/#6). Lists the workspace+server's
 * persisted threads (via the chat:* IPC bridge), grouped by date, and lets the
 * user reopen, rename, delete, search, and archive a conversation. Replaces the
 * localStorage prompt-history "Sessions" switcher (fivem-studio-7omn) with the
 * real threads that live in cloud/local Supabase memory.
 *
 * Mirrors Foreman's sidebar-history UX (debounced title+content search →
 * Results view; per-item archive with a collapsible "Archived" section; archived
 * threads excluded from the main dated list).
 */
import { useAccount } from "@renderer/lib/account";
import { cn } from "@renderer/lib/utils";
import {
  Archive,
  ArchiveRestore,
  Check,
  GitBranch,
  MessageSquarePlus,
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

interface ThreadSummary {
  id: string;
  title: string | null;
  updatedAt: string;
  archivedAt: string | null;
}

interface SearchHit {
  id: string;
  title: string | null;
  snippet: string | null;
  updatedAt: string;
  archivedAt: string | null;
}

interface ConversationSidebarProps {
  /** The currently-open thread (= useChat session id) — highlighted in the list. */
  activeThreadId: string;
  onOpenThread: (threadId: string) => void;
  onNewSession: () => void;
  /** Branch the active conversation into a new thread (replaces the old /clone). */
  onBranch: () => void;
  /** Bumps when a generation completes so a new/renamed thread shows up. */
  refreshSignal: string | null;
}

const DAY = 86_400_000;
const GROUP_ORDER = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];

function groupLabel(iso: string): string {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const t = startOfToday.getTime();
  const d = new Date(iso).getTime();
  if (d >= t) return "Today";
  if (d >= t - DAY) return "Yesterday";
  if (d >= t - 7 * DAY) return "Previous 7 days";
  if (d >= t - 30 * DAY) return "Previous 30 days";
  return "Older";
}

function displayTitle(title: string | null): string {
  return title?.trim() ? title : "Untitled conversation";
}

export function ConversationSidebar({
  activeThreadId,
  onOpenThread,
  onNewSession,
  onBranch,
  refreshSignal,
}: ConversationSidebarProps) {
  const { getToken, workspaceId } = useAccount();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // Server-side search (titles + message content), debounced.
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const isSearching = debounced.length >= 2;

  const authArgs = useCallback(async () => {
    const accessToken = (await getToken().catch(() => null)) ?? undefined;
    return { accessToken, ...(workspaceId ? { workspaceId } : {}) };
  }, [getToken, workspaceId]);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await window.api.chat.listThreads(await authArgs());
    setLoading(false);
    if (res.ok && res.threads) setThreads(res.threads);
  }, [authArgs]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: also refetch when a generation completes
  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Run the search when the debounced query changes (≥2 chars).
  useEffect(() => {
    if (!isSearching) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    void (async () => {
      const res = await window.api.chat.searchThreads({ query: debounced, ...(await authArgs()) });
      if (cancelled) return;
      setSearching(false);
      if (res.ok && res.results) setResults(res.results);
    })();
    return () => {
      cancelled = true;
    };
  }, [debounced, isSearching, authArgs]);

  const commitRename = useCallback(
    async (id: string) => {
      const title = draft.trim();
      setEditingId(null);
      if (!title) return;
      setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
      const res = await window.api.chat.renameThread({
        threadId: id,
        title,
        ...(await authArgs()),
      });
      if (!res.ok) {
        toast.error("Couldn't rename this conversation");
        void load();
      }
    },
    [draft, authArgs, load],
  );

  const setArchived = useCallback(
    async (id: string, archived: boolean) => {
      setThreads((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, archivedAt: archived ? new Date().toISOString() : null } : t,
        ),
      );
      const res = await window.api.chat.setThreadArchived({
        threadId: id,
        archived,
        ...(await authArgs()),
      });
      if (!res.ok) {
        toast.error(archived ? "Couldn't archive" : "Couldn't restore");
        void load();
        return;
      }
      if (archived) {
        toast.success("Conversation archived", {
          action: { label: "Undo", onClick: () => void setArchived(id, false) },
        });
      } else {
        toast.success("Conversation restored");
      }
    },
    [authArgs, load],
  );

  const doDelete = useCallback(
    async (id: string) => {
      setConfirmDeleteId(null);
      setThreads((prev) => prev.filter((t) => t.id !== id));
      const res = await window.api.chat.deleteThread({ threadId: id, ...(await authArgs()) });
      if (!res.ok) {
        toast.error("Couldn't delete this conversation");
        void load();
        return;
      }
      toast.success("Conversation deleted");
      if (id === activeThreadId) onNewSession();
    },
    [authArgs, load, activeThreadId, onNewSession],
  );

  const activeThreads = threads.filter((t) => !t.archivedAt);
  const archivedThreads = threads.filter((t) => t.archivedAt);
  const grouped = GROUP_ORDER.map((label) => ({
    label,
    items: activeThreads.filter((t) => groupLabel(t.updatedAt) === label),
  })).filter((g) => g.items.length > 0);

  // One conversation row (used by the dated groups and the archived section).
  function renderRow(t: ThreadSummary, archived: boolean) {
    const isActive = t.id === activeThreadId;
    if (editingId === t.id) {
      return (
        <div key={t.id} className="flex items-center gap-1 px-1 py-0.5">
          <input
            // biome-ignore lint/a11y/noAutofocus: focus the rename field on open
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename(t.id);
              if (e.key === "Escape") setEditingId(null);
            }}
            className="min-w-0 flex-1 rounded border border-border-subtle bg-elevated px-1.5 py-1 font-mono text-xs text-text-primary outline-none"
          />
          <button type="button" onClick={() => void commitRename(t.id)} title="Save">
            <Check className="size-3.5 text-accent-green" />
          </button>
          <button type="button" onClick={() => setEditingId(null)} title="Cancel">
            <X className="size-3.5 text-text-dim" />
          </button>
        </div>
      );
    }
    return (
      <div
        key={t.id}
        className={cn(
          "group flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors",
          isActive ? "bg-primary/10" : "hover:bg-hover",
        )}
      >
        <button
          type="button"
          onClick={() => onOpenThread(t.id)}
          className={cn(
            "min-w-0 flex-1 truncate text-left text-[13px] transition-colors",
            isActive ? "font-medium text-primary" : "text-text-secondary",
          )}
        >
          {displayTitle(t.title)}
        </button>
        {confirmDeleteId === t.id ? (
          <>
            <button type="button" onClick={() => void doDelete(t.id)} title="Confirm delete">
              <Check className="size-3.5 text-red-400" />
            </button>
            <button type="button" onClick={() => setConfirmDeleteId(null)} title="Cancel">
              <X className="size-3.5 text-text-dim" />
            </button>
          </>
        ) : (
          <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {archived ? (
              <button type="button" onClick={() => void setArchived(t.id, false)} title="Restore">
                <ArchiveRestore className="size-3 text-text-dim hover:text-text-primary" />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(t.title ?? "");
                    setEditingId(t.id);
                  }}
                  title="Rename"
                >
                  <Pencil className="size-3 text-text-dim hover:text-text-primary" />
                </button>
                <button type="button" onClick={() => void setArchived(t.id, true)} title="Archive">
                  <Archive className="size-3 text-text-dim hover:text-text-primary" />
                </button>
              </>
            )}
            <button type="button" onClick={() => setConfirmDeleteId(t.id)} title="Delete">
              <Trash2 className="size-3 text-text-dim hover:text-red-400" />
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-dim">
          Conversations
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onBranch}
            title="Branch this conversation"
            className="flex items-center gap-1 rounded-md border border-border-subtle bg-elevated px-1.5 py-1 text-text-muted transition-colors hover:border-text-dim hover:text-text-primary"
          >
            <GitBranch className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onNewSession}
            title="New conversation"
            className="flex items-center gap-1 rounded-md border border-border-subtle bg-elevated px-1.5 py-1 text-text-muted transition-colors hover:border-text-dim hover:text-text-primary"
          >
            <MessageSquarePlus className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Search box — titles + message content (eh2g #4). The inner relative
          wrapper is exactly the input's height so the icons center on it (the
          outer pb-2 must not throw off top-1/2). */}
      <div className="px-2 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-text-dim" />
          <input
            aria-label="Search conversations"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats…"
            className="h-8 w-full rounded-md border border-border-subtle bg-elevated pl-7 pr-7 text-[13px] text-text-primary outline-none placeholder:text-text-dim focus:border-text-dim"
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim transition-colors hover:text-text-primary"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {isSearching ? (
          <div className="mb-2">
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-dim/70">
              Results
            </div>
            {searching && results.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-text-dim">Searching…</p>
            ) : results.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-text-dim">
                No matches for “{debounced}”
              </p>
            ) : (
              results.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onOpenThread(r.id)}
                  className={cn(
                    "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors",
                    r.id === activeThreadId ? "bg-primary/10" : "hover:bg-hover",
                  )}
                >
                  <span
                    className={cn(
                      "w-full truncate text-[13px]",
                      r.id === activeThreadId ? "font-medium text-primary" : "text-text-secondary",
                    )}
                  >
                    {displayTitle(r.title)}
                    {r.archivedAt && (
                      <span className="ml-1.5 text-[9px] uppercase text-text-dim">archived</span>
                    )}
                  </span>
                  {r.snippet && (
                    <span className="w-full truncate text-[11px] text-text-dim">{r.snippet}</span>
                  )}
                </button>
              ))
            )}
          </div>
        ) : (
          <>
            {activeThreads.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-text-dim">
                {loading ? "Loading…" : "No conversations yet"}
              </p>
            ) : (
              grouped.map((group) => (
                <div key={group.label} className="mb-2">
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-dim/70">
                    {group.label}
                  </div>
                  {group.items.map((t) => renderRow(t, false))}
                </div>
              ))
            )}

            {/* Archived — collapsed by default, always reachable to restore. */}
            {archivedThreads.length > 0 && (
              <div className="mt-1 border-t border-border-subtle pt-2">
                <button
                  type="button"
                  onClick={() => setShowArchived((v) => !v)}
                  className="flex w-full items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-dim transition-colors hover:text-text-primary"
                >
                  <Archive className="size-3" />
                  <span>
                    {showArchived ? "Hide archived" : `Archived (${archivedThreads.length})`}
                  </span>
                </button>
                {showArchived && archivedThreads.map((t) => renderRow(t, true))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
