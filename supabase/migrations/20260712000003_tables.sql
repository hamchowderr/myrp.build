-- ── Consolidated baseline 03: tables, keys, indexes ──────────────────────────
-- All 15 tables in FINAL shape (every later-added column folded in; no
-- ALTER-after-CREATE). RLS toggles + policies + grants live in baseline 05.
--
-- Multi-tenant app schema: users (native Supabase Auth identity) + workspaces +
-- members + workspace-scoped Stripe billing + per-workspace usage, teams
-- (invitations + active-workspace pointer), FiveM servers, Mastra cloud chat
-- memory (threads / messages / resources / semantic-recall embeddings /
-- observational memory), the generation_logs feedback table, and the ox_corpus
-- RAG index.
--
-- Identity IS Supabase Auth: app_users.id = auth.users.id (auto-provisioned by
-- ensure_provisioned / the on_auth_user_created trigger). The renderer presents
-- its Supabase JWT and RLS scopes by auth.uid(); Edge Functions use the service
-- key and bypass RLS. Writes happen only through SECURITY DEFINER RPCs.
--
-- Tenant convention: every workspace-scoped table carries a workspace_id FK;
-- RLS is SELECT-only via public.is_workspace_member(); writes go through the
-- SECURITY DEFINER RPCs in baseline 04.

-- ── workspaces (orgs/teams; every user gets a personal one) ──────────────────
-- Declared before app_users: app_users.active_workspace_id FKs to it. (In the
-- old fix-on-fix chain that column was added by a later ALTER once workspaces
-- existed; folded into the CREATE here, so workspaces must come first. There is
-- no reverse FK — workspaces does not reference app_users.)
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null default gen_random_uuid()::text,
  name text not null,
  is_personal boolean not null default false,
  created_at timestamptz not null default now()
);

-- ── identity (linked to Supabase Auth) ───────────────────────────────────────
-- active_workspace_id is the workspace switcher's per-user selection (the
-- teams active-workspace pointer). ON DELETE SET NULL so deleting a workspace
-- just clears the pointer.
create table public.app_users (
  id                  uuid primary key references auth.users (id) on delete cascade,
  email               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  is_comped           boolean not null default false,  -- comped owner -> 'studio' plan, no billing
  active_workspace_id uuid references public.workspaces (id) on delete set null
);

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.app_users (id) on delete cascade,
  role public.workspace_member_role not null default 'developer',
  added_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);
create index idx_workspace_members_workspace on public.workspace_members (workspace_id);
create index idx_workspace_members_user on public.workspace_members (user_id);

-- ── billing (Stripe), scoped to a workspace ──────────────────────────────────
create table public.billing_customers (
  gateway_customer_id text primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  gateway_name text not null default 'stripe',
  billing_email text,
  created_at timestamptz not null default now()
);
create index idx_billing_customers_workspace on public.billing_customers (workspace_id);

create table public.billing_subscriptions (
  gateway_subscription_id text primary key,
  gateway_customer_id text not null references public.billing_customers (gateway_customer_id) on delete cascade,
  gateway_name text not null default 'stripe',
  status public.subscription_status not null,
  plan text not null default 'pro',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_billing_subscriptions_customer on public.billing_subscriptions (gateway_customer_id);

-- ── per-workspace usage (monthly) ────────────────────────────────────────────
create table public.usage_counters (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  usage_count integer not null default 0,
  usage_reset_date timestamptz not null
);

-- ── generation feedback log (RAG -> fine-tune pipeline; service-role only) ────
-- No tenant column: written + read only by the service role (the generation
-- pipeline), never the renderer.
create table public.generation_logs (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  prompt        text not null,
  model         text,
  rag_used      boolean not null default false,
  rag_chunk_count integer not null default 0,
  resource_name text,
  output_files  jsonb,           -- relative paths the agent wrote
  static_pass   boolean,         -- validator result (null = unknown)
  repair_loops  integer,         -- self-repair attempts (null = unknown)
  thread_id     text,            -- Mastra memory thread / useChat chatId
  user_rating   text check (user_rating in ('up', 'down'))  -- thumbs, null until rated
);
create index generation_logs_created_at_idx on public.generation_logs (created_at desc);
create index generation_logs_user_rating_idx on public.generation_logs (user_rating)
  where user_rating is not null;

-- ── teams: pending invitations ───────────────────────────────────────────────
-- The id IS the invite token. Created by email before the invitee necessarily
-- has an account; invitee_user_id is stamped on accept. 'admin' is defunct; an
-- invite is 'owner'-blocked by create_invitation. ON DELETE SET NULL on
-- invitee_user_id so deleting a user doesn't drop the invitation history.
create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  inviter_user_id uuid not null references public.app_users (id) on delete cascade,
  invitee_email text not null,
  invitee_role public.workspace_member_role not null default 'developer',
  status public.workspace_invitation_status not null default 'active',
  invitee_user_id uuid references public.app_users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days'
);
create index idx_workspace_invitations_workspace on public.workspace_invitations (workspace_id);
create index idx_workspace_invitations_invitee_email on public.workspace_invitations (lower(invitee_email));
create index idx_workspace_invitations_inviter on public.workspace_invitations (inviter_user_id);

-- ── servers ──────────────────────────────────────────────────────────────────
-- A workspace (personal or team) can have MULTIPLE FiveM servers. Each desktop
-- client maps its configured server to a stable client_server_key (a hash of
-- the path); ensure_server upserts the row and returns its id, which scopes the
-- Mastra memory resourceId to ws_<workspace>__srv_<server>. github_remote_url is
-- an optional non-secret https remote shared across the workspace (the per-user
-- GitHub OAuth token NEVER touches the DB — Electron safeStorage only).
create table public.servers (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  client_server_key text not null,            -- stable hash of the client's server path
  name              text,                     -- friendly label (optional)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  github_remote_url text,                     -- shared non-secret https git remote (optional)
  unique (workspace_id, client_server_key)
);
create index servers_workspace_idx on public.servers (workspace_id);

-- ── Mastra cloud chat memory: threads ────────────────────────────────────────
-- One row per conversation (useChat chatId == Mastra thread id). Scoped to a
-- workspace; server_id references servers (ON DELETE SET NULL preserves chat
-- history if a server row is removed).
create table public.mastra_threads (
  id           text primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  server_id    uuid references public.servers (id) on delete set null,
  resource_id  text not null,              -- Mastra resourceId (memory owner scope)
  title        text,
  metadata     jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index mastra_threads_workspace_idx on public.mastra_threads (workspace_id);
create index mastra_threads_resource_idx  on public.mastra_threads (resource_id);

-- ── Mastra cloud chat memory: messages ───────────────────────────────────────
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
  server_id    uuid references public.servers (id) on delete set null,
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

-- ── Mastra cloud chat memory: resources (resource-scoped working memory) ──────
-- One row per Mastra resourceId (= ws_<ws>__srv_<srv>). working_memory is the
-- persisted WM markdown; workspace_id scopes RLS + the workspace index.
create table public.mastra_resources (
  id             text primary key,           -- Mastra resourceId (memory owner scope)
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  working_memory text,
  metadata       jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index mastra_resources_workspace_idx on public.mastra_resources (workspace_id);

-- ── Mastra semantic-recall vector store ──────────────────────────────────────
-- Backs a custom SupabaseVector so Mastra Memory's semantic recall works on
-- cloud Supabase pgvector. CAPABILITY ONLY: storage is present so semantic
-- recall CAN be turned on; chat.ts keeps semanticRecall:false until the owner
-- accepts the per-message embedding cost. Embeddings are 384-dim (local
-- fastembed bge-small-en-v1.5, matching rag.ts / ox_corpus).
create table public.mastra_message_embeddings (
  id           text primary key,           -- vector id (Mastra-generated)
  message_id   text,                       -- source message id (metadata.message_id)
  thread_id    text,                       -- semantic-recall filter scope (thread)
  resource_id  text,                       -- semantic-recall filter scope (resource)
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  embedding    vector(384) not null,
  content      text,
  metadata     jsonb,
  created_at   timestamptz not null default now()
);
create index mastra_message_embeddings_workspace_idx on public.mastra_message_embeddings (workspace_id);
create index mastra_message_embeddings_thread_idx    on public.mastra_message_embeddings (thread_id);
create index mastra_message_embeddings_resource_idx  on public.mastra_message_embeddings (resource_id);
create index mastra_message_embeddings_hnsw          on public.mastra_message_embeddings using hnsw (embedding vector_cosine_ops);

-- ── Mastra observational memory ──────────────────────────────────────────────
-- Storage for Mastra's observer/reflector memory: the full
-- ObservationalMemoryRecord as a jsonb document plus a few indexed columns
-- (lookup_key, generation_count) for the queries Mastra issues. CAPABILITY only
-- — running the observer is a separate Memory-config + observer-model step.
create table public.mastra_observational_memory (
  id               text primary key,         -- record id (a new id per generation)
  lookup_key       text not null,            -- 'thread:<id>' | 'resource:<id>'
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  generation_count integer not null default 0,
  record           jsonb not null,           -- full ObservationalMemoryRecord (camelCase, ISO dates)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index mastra_om_lookup_gen_idx on public.mastra_observational_memory (lookup_key, generation_count desc);
create index mastra_om_workspace_idx  on public.mastra_observational_memory (workspace_id);

-- ── ox_corpus (shared, read-only RAG knowledge base) ─────────────────────────
-- Populated by the external fivem-rag-ingestion ops pipeline (service role);
-- reads go through match_ox_corpus. No workspace scoping — any authenticated
-- user may read it (via the SECURITY DEFINER read RPC). 384-dim embeddings
-- (local fastembed bge-small-en-v1.5).
create table public.ox_corpus (
  id        integer generated always as identity primary key,
  vector_id text unique not null,
  embedding vector(384),
  metadata  jsonb not null default '{}'
);
create index ox_corpus_hnsw on public.ox_corpus using hnsw (embedding vector_cosine_ops);
