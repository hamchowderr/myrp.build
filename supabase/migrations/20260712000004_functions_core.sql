-- ── Consolidated baseline 04a: core functions (helpers, provisioning, billing, RAG) ──
set check_function_bodies = off;

-- ── pure helpers ─────────────────────────────────────────────────────────────

-- first of next month (UTC) — usage reset boundary
create or replace function public.next_reset_date()
returns timestamptz language sql stable set search_path = public as $$
  select date_trunc('month', now() at time zone 'utc') + interval '1 month'
$$;

-- monthly generation limit per plan
create or replace function public.plan_limit(p_plan text)
returns integer language sql immutable set search_path = public as $$
  select case p_plan
    when 'studio'  then 2500
    when 'pro'     then 500
    when 'starter' then 100
    else 10  -- free / unknown
  end
$$;

-- the user's personal workspace id (billing/usage anchor for the solo case)
create or replace function public.personal_workspace_id(p_user_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select w.id from workspaces w join workspace_members wm on wm.workspace_id = w.id
  where wm.user_id = p_user_id and w.is_personal order by w.created_at limit 1
$$;

-- a workspace's plan: 'studio' if its OWNER is comped, else the plan stored on its
-- active/trialing subscription (most recently updated), else 'free'.
create or replace function public.workspace_plan(p_workspace_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when exists (
      select 1
        from workspace_members wm
        join app_users au on au.id = wm.user_id
       where wm.workspace_id = p_workspace_id
         and wm.role = 'owner'
         and au.is_comped
    ) then 'studio'
    else coalesce(
      (select s.plan
         from billing_subscriptions s
         join billing_customers c on c.gateway_customer_id = s.gateway_customer_id
        where c.workspace_id = p_workspace_id
          and s.status in ('active', 'trialing')
        order by s.updated_at desc
        limit 1),
      'free'
    )
  end
$$;

-- ── RLS helpers (identity via auth.uid(); null for the service role) ──────────
create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspace_members wm where wm.workspace_id = p_workspace_id and wm.user_id = auth.uid())
$$;

create or replace function public.get_customer_workspace_id(p_customer text)
returns uuid language sql stable security definer set search_path = public as $$
  select workspace_id from billing_customers where gateway_customer_id = p_customer
$$;

-- Owner RLS helper (mirrors is_workspace_member: one arg, identity via auth.uid()).
create or replace function public.is_workspace_owner(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = auth.uid()
      and wm.role = 'owner'
  )
$$;

-- The caller's role in a workspace ('owner' | 'admin' | 'developer'), or NULL if
-- the caller is not a member. Resolved from auth.uid() — never a client arg, so
-- turn attribution can't be spoofed.
create or replace function public.my_workspace_role(p_workspace_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select wm.role::text
  from workspace_members wm
  where wm.workspace_id = p_workspace_id and wm.user_id = auth.uid()
$$;

-- ── provisioning ─────────────────────────────────────────────────────────────

-- Shared provisioning helper — single source of truth, idempotent, concurrency-safe.
-- A per-user advisory xact lock serializes racing first-time calls (e.g. the
-- renderer's get_subscription and the proxy's get_user_workspace_plan firing
-- together) so a user can never end up with two personal workspaces.
create or replace function public.ensure_provisioned(p_user_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_ws uuid;
begin
  if p_user_id is null then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  insert into app_users (id, email)
    select p_user_id, u.email from auth.users u where u.id = p_user_id
    on conflict (id) do nothing;

  v_ws := public.personal_workspace_id(p_user_id);
  if v_ws is null then
    insert into workspaces (name, is_personal)
      values (coalesce((select email from auth.users where id = p_user_id), 'Personal'), true)
      returning id into v_ws;
    insert into workspace_members (workspace_id, user_id, role) values (v_ws, p_user_id, 'owner');
    insert into usage_counters (workspace_id, usage_count, usage_reset_date)
      values (v_ws, 0, public.next_reset_date());
  end if;
  return v_ws;
end; $$;

-- Auto-provision on Supabase Auth signup (belt-and-suspenders alongside the
-- self-healing read RPCs). Delegates to the shared helper.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.ensure_provisioned(new.id);
  return new;
end; $$;

-- ── subscription / usage reads (self-healing) ─────────────────────────────────

-- subscription snapshot for a workspace (defaults to the caller's personal ws),
-- auto-resetting usage when the period rolls over; self-provisions if needed.
create or replace function public.get_subscription(p_workspace_id uuid default null)
returns table (workspace_id uuid, plan text, usage_count integer, usage_limit integer, can_generate boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid := coalesce(p_workspace_id, public.personal_workspace_id(v_uid));
  v_plan text; v_count integer; v_limit integer;
begin
  if v_ws is null then v_ws := public.ensure_provisioned(v_uid); end if;
  if v_ws is null then return; end if;
  update usage_counters set usage_count = 0, usage_reset_date = public.next_reset_date()
    where usage_counters.workspace_id = v_ws and usage_reset_date <= now();
  v_plan := public.workspace_plan(v_ws);
  v_limit := public.plan_limit(v_plan);
  select uc.usage_count into v_count from usage_counters uc where uc.workspace_id = v_ws;
  v_count := coalesce(v_count, 0);
  return query select v_ws, v_plan, v_count, v_limit, (v_count < v_limit);
end; $$;

-- worker/edge entry point: resolve a user's plan/usage by Supabase user id
-- (optional explicit ws). Called with the service key + the verified JWT `sub`.
create or replace function public.get_user_workspace_plan(p_user_id uuid, p_workspace_id uuid default null)
returns table (workspace_id uuid, plan text, usage_count integer, usage_limit integer, can_generate boolean)
language plpgsql security definer set search_path = public as $$
declare v_ws uuid;
begin
  if p_workspace_id is not null and exists (
    select 1 from workspace_members wm where wm.workspace_id = p_workspace_id and wm.user_id = p_user_id
  ) then v_ws := p_workspace_id; else v_ws := public.personal_workspace_id(p_user_id); end if;
  if v_ws is null then v_ws := public.ensure_provisioned(p_user_id); end if;
  if v_ws is null then return; end if;
  update usage_counters set usage_count = 0, usage_reset_date = public.next_reset_date()
    where usage_counters.workspace_id = v_ws and usage_reset_date <= now();
  return query select v_ws, public.workspace_plan(v_ws),
    coalesce((select uc.usage_count from usage_counters uc where uc.workspace_id = v_ws), 0),
    public.plan_limit(public.workspace_plan(v_ws)),
    coalesce((select uc.usage_count from usage_counters uc where uc.workspace_id = v_ws), 0) < public.plan_limit(public.workspace_plan(v_ws));
end; $$;

-- cap-aware increment for a workspace; returns true if counted, false if over cap
create or replace function public.increment_usage(p_workspace_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_plan text := public.workspace_plan(p_workspace_id);
  v_limit integer := public.plan_limit(v_plan);
  v_count integer;
begin
  update usage_counters set usage_count = 0, usage_reset_date = public.next_reset_date()
    where workspace_id = p_workspace_id and usage_reset_date <= now();
  select usage_count into v_count from usage_counters where workspace_id = p_workspace_id;
  if v_count is null then
    insert into usage_counters (workspace_id, usage_count, usage_reset_date)
      values (p_workspace_id, 0, public.next_reset_date()) returning usage_count into v_count;
  end if;
  if v_count >= v_limit then return false; end if;
  update usage_counters set usage_count = usage_count + 1 where workspace_id = p_workspace_id;
  return true;
end;
$$;

-- ── billing writes (called by the Stripe edge functions) ─────────────────────

-- ensure a Stripe customer row for a workspace (called by create-checkout)
create or replace function public.ensure_billing_customer(p_workspace_id uuid, p_customer_id text, p_email text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into billing_customers (gateway_customer_id, workspace_id, billing_email)
  values (p_customer_id, p_workspace_id, p_email)
  on conflict (gateway_customer_id) do update set billing_email = coalesce(excluded.billing_email, billing_customers.billing_email);
end;
$$;

-- upsert a subscription from the Stripe webhook (by customer)
create or replace function public.update_subscription(
  p_customer_id text, p_subscription_id text, p_status public.subscription_status,
  p_plan text default 'pro', p_period_start timestamptz default null,
  p_period_end timestamptz default null, p_cancel_at_period_end boolean default false
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into billing_subscriptions (
    gateway_subscription_id, gateway_customer_id, status, plan,
    current_period_start, current_period_end, cancel_at_period_end, updated_at
  ) values (
    p_subscription_id, p_customer_id, p_status, p_plan,
    p_period_start, p_period_end, p_cancel_at_period_end, now()
  )
  on conflict (gateway_subscription_id) do update set
    status = excluded.status, plan = excluded.plan,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end, updated_at = now();
end;
$$;

-- ── workspace management (teams) — keyed by Supabase user id ──────────────────
create or replace function public.create_workspace(p_user_id uuid, p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_ws uuid;
begin
  if not exists (select 1 from app_users where id = p_user_id) then
    raise exception 'unknown user %', p_user_id;
  end if;
  insert into workspaces (name, is_personal) values (p_name, false) returning id into v_ws;
  insert into workspace_members (workspace_id, user_id, role) values (v_ws, p_user_id, 'owner');
  insert into usage_counters (workspace_id, usage_count, usage_reset_date) values (v_ws, 0, public.next_reset_date());
  return v_ws;
end;
$$;

create or replace function public.add_workspace_member(p_workspace_id uuid, p_user_id uuid, p_role public.workspace_member_role default 'developer')
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from app_users where id = p_user_id) then
    raise exception 'unknown user %', p_user_id;
  end if;
  insert into workspace_members (workspace_id, user_id, role) values (p_workspace_id, p_user_id, p_role)
  on conflict (workspace_id, user_id) do update set role = excluded.role;
end;
$$;

-- ── RAG read RPC ─────────────────────────────────────────────────────────────
-- ox_corpus is a SHARED, read-only knowledge base (ox/FiveM docs) — no workspace
-- scoping; any AUTHENTICATED user may read it. SECURITY DEFINER so the read
-- reliably succeeds for any authenticated JWT regardless of ox_corpus's RLS/grant
-- state, while still REQUIRING authentication (auth.uid() not null — the baked
-- anon key alone, with no user JWT, cannot read the corpus).
create or replace function public.match_ox_corpus(
  query_embedding vector,
  match_count integer default 8
)
returns table (
  text text,
  source_url text,
  source_type text,
  similarity double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select
    metadata->>'text' as text,
    metadata->>'source_url' as source_url,
    metadata->>'source_type' as source_type,
    1 - (embedding <=> query_embedding) as similarity
  from public.ox_corpus
  -- Require an authenticated caller: the shared corpus is readable by any signed-in
  -- user, but never by an unauthenticated request bearing only the anon key.
  where auth.uid() is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
