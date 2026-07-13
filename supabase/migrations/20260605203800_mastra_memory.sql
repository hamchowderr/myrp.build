-- ── Mastra cloud chat memory ─────────────────────────────────────────────────
-- Durable, per-tenant Mastra chat memory (threads + messages) in cloud Supabase.
-- Mirrors the @mastra/pg memory domain shape (thread/message columns) but adds
-- the multi-tenant convention from baseline 03: every row carries a
-- `workspace_id` FK; RLS is SELECT-ONLY via public.is_workspace_member(); all
-- writes go through the SECURITY DEFINER RPCs in the next migration (M2.2).
--
-- Workflow approval SNAPSHOTS deliberately do NOT live here — they stay local
-- (in-process InMemoryStore, M1). Only conversational memory is cloud-backed.
--
-- The custom adapter (src/main/mastra/storage) owns all SQL it issues, so column
-- names are clean snake_case; the adapter maps them to the Mastra row shape
-- (id, content, role, type, createdAt, threadId, resourceId).

-- ── threads ──────────────────────────────────────────────────────────────────
-- One row per conversation (useChat chatId == Mastra thread id). Scoped to a
-- workspace; server_id is nullable for M2 (personal workspace, no server yet —
-- the servers table + scheme arrive in M3.1).
create table public.mastra_threads (
  id           text primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  server_id    uuid,                       -- nullable until M3.1 (servers table)
  resource_id  text not null,              -- Mastra resourceId (memory owner scope)
  title        text,
  metadata     jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index mastra_threads_workspace_idx on public.mastra_threads (workspace_id);
create index mastra_threads_resource_idx  on public.mastra_threads (resource_id);

-- ── messages ─────────────────────────────────────────────────────────────────
-- One row per stored message. content is the Mastra MastraMessageContentV2 (v2
-- format) as jsonb. author_id/author_email stamp the authenticated author of a
-- user-role message (set server-side by the write RPC from auth.uid()/auth.email()
-- — never trusted from the client). workspace_id is denormalized for RLS + the
-- workspace index; it must match the parent thread's workspace_id (enforced by
-- the write RPC).
create table public.mastra_messages (
  id           text primary key,
  thread_id    text not null references public.mastra_threads (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  server_id    uuid,                       -- nullable until M3.1
  resource_id  text,                       -- Mastra resourceId (nullable per @mastra row)
  role         text not null,              -- 'user' | 'assistant' | 'system' | 'signal'
  type         text not null default 'v2', -- message format discriminator
  content      jsonb not null,             -- MastraMessageContentV2
  author_id    uuid,                       -- auth.uid() of the user author (role='user')
  author_email text,                       -- auth.email() of the user author (role='user')
  created_at   timestamptz not null default now()
);

create index mastra_messages_thread_created_idx on public.mastra_messages (thread_id, created_at);
create index mastra_messages_workspace_idx      on public.mastra_messages (workspace_id);
create index mastra_messages_resource_idx       on public.mastra_messages (resource_id);

-- ── RLS: SELECT-only for the anon/JWT role (writes via SECURITY DEFINER RPCs) ──
-- Identity via auth.uid(); the service role bypasses RLS. No INSERT/UPDATE/DELETE
-- policies — RLS denies those for the anon role by default (baseline 05 pattern).
alter table public.mastra_threads enable row level security;
alter table public.mastra_messages enable row level security;

create policy "read ws mastra threads" on public.mastra_threads
  for select using (public.is_workspace_member(workspace_id));

create policy "read ws mastra messages" on public.mastra_messages
  for select using (public.is_workspace_member(workspace_id));
