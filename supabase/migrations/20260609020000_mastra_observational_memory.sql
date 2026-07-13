-- ── Mastra observational memory ─────────────────────────────────────
-- Storage for Mastra's observer/reflector memory. The intricate observe/buffer/
-- reflect LOGIC lives in @mastra/memory; the storage layer is mechanical CRUD on
-- ONE record. We store the full ObservationalMemoryRecord as a jsonb document
-- (dates as ISO strings) plus a few indexed columns (lookup_key, generation_count)
-- for the queries Mastra issues — so a single shallow-merge patch RPC covers every
-- field setter (the adapter computes swap/merge results in JS, then patches).
--
-- Same security model as the rest of cloud memory: RLS SELECT-only, all writes via
-- SECURITY DEFINER RPCs that re-check is_workspace_member.
--
-- CAPABILITY: this gives SupabaseMemoryStorage observational-memory parity
-- (supportsObservationalMemory=true). Actually RUNNING the observer is a separate
-- Memory-config + observer-model step (extra LLM cost), not enabled here.

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

alter table public.mastra_observational_memory enable row level security;

create policy "read ws mastra om" on public.mastra_observational_memory
  for select using (public.is_workspace_member(workspace_id));

-- Insert or replace a full OM record (used by initialize / insert / new generation).
create or replace function public.mastra_om_upsert(
  p_workspace_id     uuid,
  p_id               text,
  p_lookup_key       text,
  p_generation_count integer,
  p_record           jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace';
  end if;
  insert into mastra_observational_memory (id, lookup_key, workspace_id, generation_count, record, created_at, updated_at)
    values (p_id, p_lookup_key, p_workspace_id, coalesce(p_generation_count, 0), p_record, now(), now())
  on conflict (id) do update set
    record           = excluded.record,
    generation_count = excluded.generation_count,
    lookup_key       = excluded.lookup_key,
    updated_at       = now()
  where public.is_workspace_member(mastra_observational_memory.workspace_id);
end; $$;

-- Shallow-merge a patch into an existing record (record || p_patch). The adapter
-- computes any derived values (token totals, swaps, deep-merged config) in JS and
-- sends the resolved fields, so a shallow merge is sufficient + faithful.
create or replace function public.mastra_om_patch(p_id text, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_ws uuid;
begin
  select workspace_id into v_ws from mastra_observational_memory where id = p_id;
  if v_ws is null then raise exception 'observational memory record not found: %', p_id; end if;
  if not public.is_workspace_member(v_ws) then raise exception 'not a member of this workspace'; end if;
  update mastra_observational_memory set
    record           = record || p_patch,
    generation_count = coalesce((p_patch ->> 'generationCount')::integer, generation_count),
    updated_at       = now()
  where id = p_id;
end; $$;

-- Delete all generations for a lookup key (clearObservationalMemory).
create or replace function public.mastra_om_clear(p_lookup_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from mastra_observational_memory e
  where e.lookup_key = p_lookup_key and public.is_workspace_member(e.workspace_id);
end; $$;
