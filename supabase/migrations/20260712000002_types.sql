-- ── Consolidated baseline 02: enum types ─────────────────────────────────────
-- Declared in FINAL form (no create-then-rename). Roles are Owner + Developer;
-- 'admin' is defunct (never assigned) but kept in the type for compatibility.

create type public.workspace_member_role as enum ('owner', 'admin', 'developer');

create type public.subscription_status as enum (
  'trialing', 'active', 'canceled', 'incomplete',
  'incomplete_expired', 'past_due', 'unpaid', 'paused'
);

create type public.workspace_invitation_status as enum (
  'active', 'accepted', 'declined', 'revoked'
);
