-- ── Teams — schema ───────────────────────────────────────────────────────────
-- First forward migration on top of the clean baseline.
-- Foundation for the teams epic: multi-member workspaces with
-- two roles — Owner + Developer — and in-app pending invitations matched by email
-- (no email infra). 'admin' is left defunct (never assigned). Forward-only.

-- 1) Role rename: 'member' -> 'developer' (keep 'owner'; 'admin' stays defunct).
--    RENAME VALUE keeps the same underlying enum value, so existing rows + stored
--    defaults still resolve — but we reset the textual defaults below for clarity.
alter type public.workspace_member_role rename value 'member' to 'developer';

alter table public.workspace_members alter column role set default 'developer';

-- add_workspace_member's signature default referenced the old 'member' label; recreate.
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

-- 2) Invitation status enum.
create type public.workspace_invitation_status as enum ('active', 'accepted', 'declined', 'revoked');

-- 3) Pending invitations. The id IS the invite token. Created by email before the
--    invitee necessarily has an account; invitee_user_id is stamped on accept.
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

-- 4) Owner RLS helper (mirrors is_workspace_member: one arg, identity via auth.uid()).
create or replace function public.is_workspace_owner(p_workspace_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = auth.uid()
      and wm.role = 'owner'
  )
$$;

-- 5) Per-user active workspace pointer (the workspace switcher's selection).
--    ON DELETE SET NULL so deleting a workspace just clears the pointer.
alter table public.app_users
  add column active_workspace_id uuid references public.workspaces (id) on delete set null;

-- 6) RLS for invitations — SELECT-only for the JWT role (writes go through the
--    SECURITY DEFINER RPCs, consistent with the baseline). Owner sees the
--    workspace's invitations; invitee sees their own by matching JWT email.
alter table public.workspace_invitations enable row level security;

create policy "owner reads workspace invitations" on public.workspace_invitations
  for select using (public.is_workspace_owner(workspace_id));

create policy "invitee reads own invitations" on public.workspace_invitations
  for select using (lower(invitee_email) = lower((select auth.email())));
