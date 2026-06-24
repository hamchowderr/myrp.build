/**
 * Per-run storage context for the cloud Mastra memory adapter (M2.3 —
 * fivem-studio-825).
 *
 * Bundles the authenticated run client + the resolved tenant identity so the
 * SupabaseMemoryStorage adapter can scope every read/write. All of these are
 * resolved in ipc/chat.ts (M2.4) from the per-run JWT: workspaceId via the
 * active workspace (fallback get_subscription), authorId/authorEmail via
 * supabase.auth.getUser(), resourceId from the workspace/server scope. serverId
 * is null for M2 (personal workspace, no server) and becomes real in M3.1.
 */
import type { RunSupabaseClient } from "./supabase-client";

export interface RunStorageContext {
  /** Supabase client authenticated as the run's user (anon key + JWT). */
  client: RunSupabaseClient;
  /** Active workspace the conversation is scoped to. */
  workspaceId: string;
  /** Server within the workspace (null until M3.1 wires the servers table). */
  serverId: string | null;
  /** Mastra resourceId (memory owner scope) for new threads/messages. */
  resourceId: string;
  /** Authenticated author id (auth.uid()) — stamped server-side, passed for
   *  completeness/debug; the RPCs re-derive identity and ignore client values. */
  authorId: string;
  /** Authenticated author email (auth.email()). */
  authorEmail: string;
}
