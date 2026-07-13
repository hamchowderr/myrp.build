-- ── Clean baseline 02: enums ─────────────────────────────────────────────────
-- workspace_member_role: 'admin' is currently defunct (only owner/member are
-- assigned); the teams epic renames 'member'->'developer'
-- in its own forward migration — the baseline stays faithful to today's schema.

create type public.workspace_member_role as enum ('owner', 'admin', 'member');

create type public.subscription_status as enum (
  'trialing', 'active', 'canceled', 'incomplete',
  'incomplete_expired', 'past_due', 'unpaid', 'paused'
);
