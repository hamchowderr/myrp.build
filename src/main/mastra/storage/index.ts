/**
 * Cloud Mastra memory store factory.
 *
 * Composes a MastraCompositeStore whose `memory` domain is the cloud Supabase
 * adapter and whose `workflows` domain stays LOCAL (a fresh InMemoryStore's
 * workflows domain). This is the storage routing decision from the plan:
 * conversational memory is durable + per-tenant in the cloud, while workflow
 * approval snapshots remain in-process — single-turn suspend/resume needs
 * no network round-trip and previously crashed packaged builds.
 *
 * `disableInit: true` because the cloud tables are created by migrations,
 * never at runtime — the JWT-scoped client has no DDL rights anyway.
 */
import { InMemoryStore, MastraCompositeStore } from "@mastra/core/storage";
import type { RunStorageContext } from "./context";
import { SupabaseMemoryStorage } from "./memory";

export type { RunStorageContext } from "./context";
export { SupabaseMemoryStorage } from "./memory";
export type { RunSupabaseClient } from "./supabase-client";
export { createRunClient, getSupabaseAnonKey, getSupabaseUrl } from "./supabase-client";
export {
  buildTurnTag,
  deriveAuthorName,
  TEAM_PARTICIPANTS_TEMPLATE,
  type TurnIdentity,
  tagUserMessage,
} from "./turn-tag";
export { SupabaseVector } from "./vector";

/**
 * Build a composite store: memory = cloud Supabase (scoped by `ctx`),
 * workflows = local in-memory.
 */
export function createSupabaseMemoryStore(ctx: RunStorageContext): MastraCompositeStore {
  return new MastraCompositeStore({
    id: "myrp-build-cloud-memory",
    disableInit: true,
    domains: {
      memory: new SupabaseMemoryStorage(ctx),
      workflows: new InMemoryStore().stores.workflows,
    },
  });
}
