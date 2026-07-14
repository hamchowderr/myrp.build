-- ── Mastra AI-tracing sink: prod observability spans (pa6) ───────────────────
-- Persists the generation Harness's AI-trace spans to cloud Supabase using the
-- SAME secure pattern as chat memory: RLS-gated SELECT (is_workspace_member) +
-- a SECURITY DEFINER write RPC (mastra_save_spans). No DB credential ships — the
-- run client is anon key + per-run JWT. The MastraStorageExporter runs the
-- 'insert-only' strategy, so each span is written ONCE at span-end (no updates).
-- Column set = the queryable subset of @mastra/core CreateSpanRecord; the full
-- record is preserved in `record` (jsonb) so nothing is lost.
set check_function_bodies = off;

create table public.mastra_ai_spans (
  trace_id       text not null,
  span_id        text not null,
  parent_span_id text,
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  resource_id    text,                        -- Mastra resourceId (ws_<ws>__srv_<srv>) when set
  thread_id      text,
  run_id         text,
  name           text not null,
  span_type      text not null,               -- @mastra SpanType (agent_run / llm_generation / tool_call …)
  is_event       boolean not null default false,
  started_at     timestamptz not null,
  ended_at       timestamptz,
  error          jsonb,
  record         jsonb not null,              -- full CreateSpanRecord (source of truth)
  created_at     timestamptz not null default now(),
  primary key (trace_id, span_id)
);
create index mastra_ai_spans_workspace_started_idx on public.mastra_ai_spans (workspace_id, started_at desc);
create index mastra_ai_spans_trace_idx             on public.mastra_ai_spans (trace_id);
create index mastra_ai_spans_thread_idx            on public.mastra_ai_spans (thread_id);

-- ── RLS: tenant SELECT (identity via auth.uid()); writes are RPC-only ─────────
alter table public.mastra_ai_spans enable row level security;

create policy "read ws mastra ai spans" on public.mastra_ai_spans
  for select using (public.is_workspace_member(workspace_id));

grant select on public.mastra_ai_spans to authenticated;

-- ── Write RPC: bulk-insert spans for a workspace the caller belongs to ────────
-- p_spans is a JSON array of @mastra CreateSpanRecord objects. workspace_id is
-- taken from the caller's validated scope (ctx.workspaceId) — NOT from client
-- span data — so trace ownership can't be spoofed. Idempotent: re-delivered
-- spans (same trace/span id) are dropped ON CONFLICT.
create or replace function public.mastra_save_spans(
  p_spans        jsonb,
  p_workspace_id uuid
) returns void language plpgsql security definer set search_path = public as $$
declare v_span jsonb;
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'not a member of this workspace';
  end if;
  if p_spans is null or jsonb_typeof(p_spans) <> 'array' then return; end if;

  for v_span in select * from jsonb_array_elements(p_spans) loop
    -- Skip malformed spans (missing the identifying pair) rather than aborting the batch.
    continue when (v_span ->> 'traceId') is null or (v_span ->> 'spanId') is null;
    insert into mastra_ai_spans (
      trace_id, span_id, parent_span_id, workspace_id, resource_id, thread_id, run_id,
      name, span_type, is_event, started_at, ended_at, error, record
    ) values (
      v_span ->> 'traceId',
      v_span ->> 'spanId',
      v_span ->> 'parentSpanId',
      p_workspace_id,
      v_span ->> 'resourceId',
      v_span ->> 'threadId',
      v_span ->> 'runId',
      coalesce(v_span ->> 'name', ''),
      coalesce(v_span ->> 'spanType', ''),
      coalesce((v_span ->> 'isEvent')::boolean, false),
      coalesce((v_span ->> 'startedAt')::timestamptz, now()),
      (v_span ->> 'endedAt')::timestamptz,
      v_span -> 'error',
      v_span
    )
    on conflict (trace_id, span_id) do nothing;
  end loop;
end; $$;

revoke execute on function public.mastra_save_spans(jsonb, uuid) from public, anon;
grant  execute on function public.mastra_save_spans(jsonb, uuid) to authenticated, service_role;
