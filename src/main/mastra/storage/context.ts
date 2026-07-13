/**
 * Per-run storage context for the cloud Mastra memory adapter.
 *
 * Bundles the authenticated run client + the resolved tenant identity so the
 * SupabaseMemoryStorage adapter can scope every read/write. All of these are
 * resolved in ipc/chat.ts from the per-run JWT: workspaceId via the
 * active workspace (fallback get_subscription), authorId/authorEmail via
 * supabase.auth.getUser(), resourceId from the workspace/server scope. serverId
 * is null for the personal workspace (no server) and becomes real once the servers table is wired.
 */
import type { RunSupabaseClient } from "./supabase-client";

export interface RunStorageContext {
  /** Supabase client authenticated as the run's user (anon key + JWT). */
  client: RunSupabaseClient;
  /** Active workspace the conversation is scoped to. */
  workspaceId: string;
  /** Server within the workspace (null until the servers table is wired). */
  serverId: string | null;
  /** Mastra resourceId (memory owner scope) for new threads/messages. */
  resourceId: string;
  /** Authenticated author id (auth.uid()) — stamped server-side, passed for
   *  completeness/debug; the RPCs re-derive identity and ignore client values. */
  authorId: string;
  /** Authenticated author email (auth.email()). */
  authorEmail: string;
}
