-- ── Clean baseline 03: tables, keys, indexes, RLS toggles ────────────────────
-- Multi-tenant app schema: users (native Supabase Auth identity) + workspaces +
-- members + workspace-scoped Stripe billing + per-workspace usage, plus the
-- generation_logs feedback table for the RAG -> fine-tune pipeline.
--
-- Identity IS Supabase Auth: app_users.id = auth.users.id (auto-provisioned by
-- ensure_provisioned / the on_auth_user_created trigger). The renderer presents
-- its Supabase JWT and RLS scopes by auth.uid(); Edge Functions use the service
-- key and bypass RLS. Writes happen only through SECURITY DEFINER RPCs.

-- ── identity (linked to Supabase Auth) ───────────────────────────────────────
create table public.app_users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_comped boolean not null default false  -- comped owner -> 'studio' plan, no billing
);

-- ── workspaces (orgs/teams; every user gets a personal one) ──────────────────
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null default gen_random_uuid()::text,
  name text not null,
  is_personal boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.app_users (id) on delete cascade,
  role public.workspace_member_role not null default 'member',
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

-- ── enable RLS (renderer = anon key + Supabase JWT; service role bypasses) ────
-- 6 of 7 tables. generation_logs is intentionally NOT RLS-enabled — it is written
-- and read only by the service role (the generation pipeline), never the renderer.
alter table public.app_users enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.billing_customers enable row level security;
alter table public.billing_subscriptions enable row level security;
alter table public.usage_counters enable row level security;
