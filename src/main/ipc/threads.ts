/**
 * IPC bridge for persisted conversation management.
 *
 * The cloud memory backend (SupabaseMemoryStorage) already implements
 * list/load/rename/delete with per-workspace RLS scoping; the renderer just had
 * no way to reach it, so persisted threads were write-only. These handlers
 * surface that backend so the chat can list and reopen past conversations
 * instead of only ever holding one throwaway thread.
 *
 * Same memory adapter the chat uses (cloud in prod; local Supabase via the
 * seeded dev JWT in dev-bypass, v1f9). Kept in its own file because ipc/chat.ts
 * is already past the 500-line cap.
 */
import { Agent, MessageList } from "@mastra/core/agent";
import { ipcMain } from "electron";
import log from "electron-log/main";
import { getActiveServer } from "../../renderer/src/lib/server-registry";
import { getDevAccessToken } from "../mastra/storage/dev-auth";
import { readSettings } from "../shared-state";
import { type CloudMemory, resolveCloudMemory, resolveFollowupModel } from "./chat";

/** Lightweight thread row for the renderer's conversation list. */
interface ThreadSummary {
  id: string;
  title: string | null;
  updatedAt: string;
  /** ISO timestamp when archived (from thread metadata), else null. */
  archivedAt: string | null;
}

/** A search hit: a matching thread + a snippet around the body match. */
interface ThreadSearchResult {
  id: string;
  title: string | null;
  snippet: string | null;
  updatedAt: string;
  archivedAt: string | null;
}

/** Readable message for a thrown value — including Supabase/Postgres error
 *  objects ({ message, code, details, hint }), which aren't Error instances and
 *  would otherwise stringify to "[object Object]". */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return String(err);
}

/** Read archivedAt out of a thread's metadata (set by setThreadArchived). */
function readArchivedAt(metadata: unknown): string | null {
  if (metadata && typeof metadata === "object" && "archivedAt" in metadata) {
    const v = (metadata as { archivedAt?: unknown }).archivedAt;
    return typeof v === "string" ? v : null;
  }
  return null;
}

interface ThreadOpPayload {
  accessToken?: string;
  workspaceId?: string;
}

/** Instruction for the follow-up suggester (chat:suggestFollowups) — grounded in
 *  the resource just built, ox-only, click-to-send imperatives, one per line. */
const FOLLOWUP_INSTRUCTIONS =
  "You suggest the next thing a FiveM server builder might ask the agent to do, grounded in the " +
  "ox_overextended resource just built in this conversation. Output 3-4 short, specific, actionable " +
  "follow-up prompts the user could click to send as their next message — each an imperative " +
  '(e.g. "Add a configurable price and cooldown", "Restrict it to admins with ACE perms", ' +
  '"Add an ox_target zone to trigger it"). Rules: ox_overextended only ' +
  "(ox_core / ox_lib / ox_inventory / ox_target / oxmysql — never ESX or QBCore). One suggestion " +
  "per line. No numbering, no bullets, no quotes, no preamble. 3-8 words each. If there is nothing " +
  "useful to suggest, output nothing.";

/** Compact the recalled thread into a short transcript (last few messages, text
 *  only, truncated) for the suggester — keeps the extra LLM call cheap. */
function buildTranscript(messages: unknown[]): string {
  const ui = new MessageList().add(messages as never, "memory").get.all.aiV6.ui();
  const lines: string[] = [];
  for (const m of ui.slice(-6)) {
    const text = (m.parts ?? [])
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .trim();
    if (!text) continue;
    lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${text.slice(0, 1000)}`);
  }
  return lines.join("\n\n");
}

/** Parse the model's plaintext output into clean suggestion chips. Strips any
 *  bullet/number prefixes, drops junk, caps at 4. */
function parseFollowups(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter((l) => l.length >= 3 && l.length <= 80)
    .slice(0, 4);
}

/** Resolve cloud memory for a thread-management op (mirrors chat:clone's preamble). */
async function resolveThreadMemory(payload: ThreadOpPayload): Promise<CloudMemory | undefined> {
  const server = getActiveServer(await readSettings());
  const accessToken =
    payload.accessToken ?? (__DEV_BYPASS__ ? await getDevAccessToken() : undefined);
  return resolveCloudMemory(accessToken, payload.workspaceId, server?.serverPath);
}

export function registerThreadHandlers(): void {
  // List the active workspace+server's conversations, newest first.
  ipcMain.handle(
    "chat:listThreads",
    async (
      _event,
      payload: ThreadOpPayload,
    ): Promise<{ ok: boolean; threads?: ThreadSummary[]; error?: string }> => {
      try {
        const cloud = await resolveThreadMemory(payload);
        if (!cloud) return { ok: false, error: "No chat memory is configured." };
        const { threads } = await cloud.memory.listThreads({
          filter: { resourceId: cloud.resourceId },
          orderBy: { field: "updatedAt", direction: "DESC" },
        });
        return {
          ok: true,
          threads: threads.map((t) => ({
            id: t.id,
            title: t.title ?? null,
            updatedAt: new Date(t.updatedAt).toISOString(),
            archivedAt: readArchivedAt(t.metadata),
          })),
        };
      } catch (err) {
        log.warn("[threads] listThreads failed:", err);
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  // Load a thread's full message history as AI SDK v6 UI messages, ready to seed
  // straight into the renderer's useChat via setMessages. Same shape
  // the live stream produces, so reopening a conversation renders identically.
  ipcMain.handle(
    "chat:loadThread",
    async (
      _event,
      payload: ThreadOpPayload & { threadId: string },
    ): Promise<{ ok: boolean; messages?: unknown[]; error?: string }> => {
      try {
        const cloud = await resolveThreadMemory(payload);
        if (!cloud) return { ok: false, error: "No chat memory is configured." };
        const { messages } = await cloud.memory.recall({
          threadId: payload.threadId,
          resourceId: cloud.resourceId,
        });
        const uiMessages = new MessageList().add(messages, "memory").get.all.aiV6.ui();
        return { ok: true, messages: uiMessages };
      } catch (err) {
        log.warn("[threads] loadThread failed:", err);
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  // Rename a thread. updateThread requires metadata, so preserve the existing
  // metadata — passing {} would wipe working-memory/clone metadata.
  ipcMain.handle(
    "chat:renameThread",
    async (
      _event,
      payload: ThreadOpPayload & { threadId: string; title: string },
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const cloud = await resolveThreadMemory(payload);
        if (!cloud) return { ok: false, error: "No chat memory is configured." };
        const existing = await cloud.memory.getThreadById({ threadId: payload.threadId });
        await cloud.memory.updateThread({
          id: payload.threadId,
          title: payload.title,
          metadata: existing?.metadata ?? {},
        });
        return { ok: true };
      } catch (err) {
        log.warn("[threads] renameThread failed:", err);
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  // Delete a thread (cascades its messages via mastra_delete_thread).
  ipcMain.handle(
    "chat:deleteThread",
    async (
      _event,
      payload: ThreadOpPayload & { threadId: string },
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const cloud = await resolveThreadMemory(payload);
        if (!cloud) return { ok: false, error: "No chat memory is configured." };
        await cloud.memory.deleteThread(payload.threadId);
        return { ok: true };
      } catch (err) {
        log.warn("[threads] deleteThread failed:", err);
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  // Search this resource's conversations by title + message content.
  // One SECURITY DEFINER RPC (mastra_search_messages) does the membership-checked
  // jsonb scan + snippet server-side — PostgREST can't ILIKE a jsonb column from
  // the client. Covers archived threads too (the UI can badge them).
  ipcMain.handle(
    "chat:searchThreads",
    async (
      _event,
      payload: ThreadOpPayload & { query: string },
    ): Promise<{ ok: boolean; results?: ThreadSearchResult[]; error?: string }> => {
      try {
        const q = (payload.query ?? "").trim();
        if (q.length < 2) return { ok: true, results: [] };
        const cloud = await resolveThreadMemory(payload);
        if (!cloud) return { ok: false, error: "No chat memory is configured." };
        const { data, error } = await cloud.client.rpc("mastra_search_messages", {
          p_resource_id: cloud.resourceId,
          p_query: q,
        });
        if (error) throw error;
        return {
          ok: true,
          results: (data ?? []).map((r) => ({
            id: r.thread_id,
            title: r.title ?? null,
            snippet: r.snippet ?? null,
            updatedAt: new Date(r.updated_at).toISOString(),
            archivedAt: r.archived_at ?? null,
          })),
        };
      } catch (err) {
        log.warn("[threads] searchThreads failed:", err);
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  // Archive / restore a thread. No schema change — the archived state
  // lives in the thread's metadata.archivedAt (mastra_update_thread merges it).
  // The existing title is preserved (coalesce keeps it if we pass the current
  // value), so archiving never disturbs the generated title.
  ipcMain.handle(
    "chat:setThreadArchived",
    async (
      _event,
      payload: ThreadOpPayload & { threadId: string; archived: boolean },
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const cloud = await resolveThreadMemory(payload);
        if (!cloud) return { ok: false, error: "No chat memory is configured." };
        const existing = await cloud.memory.getThreadById({ threadId: payload.threadId });
        await cloud.memory.updateThread({
          id: payload.threadId,
          title: existing?.title ?? "",
          // Merged server-side into existing metadata; null restores (un-archives).
          metadata: { archivedAt: payload.archived ? new Date().toISOString() : null },
        });
        return { ok: true };
      } catch (err) {
        log.warn("[threads] setThreadArchived failed:", err);
        return { ok: false, error: errMsg(err) };
      }
    },
  );

  // Dynamic follow-up suggestions: after a turn completes, the cheap
  // observer model proposes 3-4 next-step prompts grounded in what was just
  // built, surfaced as clickable chips under the last reply. Best-effort — any
  // failure (no model, no memory, parse miss) degrades to [] so the chat is
  // never blocked over suggestions. In prod this routes through the inference
  // proxy as a free memory-op (no quota/metering); in dev it uses the same
  // ANTHROPIC_API_KEY/gateway as generateTitle.
  ipcMain.handle(
    "chat:suggestFollowups",
    async (
      _event,
      payload: ThreadOpPayload & { threadId: string },
    ): Promise<{ ok: boolean; suggestions?: string[]; error?: string }> => {
      try {
        const model = resolveFollowupModel(payload.accessToken);
        if (!model) return { ok: true, suggestions: [] }; // no inference path
        const cloud = await resolveThreadMemory(payload);
        if (!cloud) return { ok: true, suggestions: [] };
        const { messages } = await cloud.memory.recall({
          threadId: payload.threadId,
          resourceId: cloud.resourceId,
        });
        const transcript = buildTranscript(messages ?? []);
        if (!transcript) return { ok: true, suggestions: [] };
        const suggester = new Agent({
          id: "followup-suggester",
          name: "followup-suggester",
          instructions: FOLLOWUP_INSTRUCTIONS,
          model,
        });
        const out = await suggester.generate(transcript);
        return { ok: true, suggestions: parseFollowups((out as { text?: string }).text ?? "") };
      } catch (err) {
        // Suggestions are non-essential — log and degrade, never surface an error.
        log.warn("[threads] suggestFollowups failed:", err);
        return { ok: true, suggestions: [] };
      }
    },
  );
}
