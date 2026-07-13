-- ── Teams — management RPCs ──────────────────────────────────────────────────
-- All SECURITY DEFINER, identity via auth.uid()/auth.email() (the real caller, not
-- the definer). Writes to teams tables happen ONLY here (RLS is SELECT-only), so
-- authorization is enforced inside each function. No explicit grants — the public
-- schema's default privileges grant EXECUTE to anon/authenticated/service_role.

-- Create a new (non-personal) team workspace owned by the caller.
create or replace function public.create_team_workspace(p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_ws uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  perform public.ensure_provisioned(v_uid);
  insert into workspaces (name, is_personal) values (p_name, false) returning id into v_ws;
  insert into workspace_members (workspace_id, user_id, role) values (v_ws, v_uid, 'owner');
  insert into usage_counters (workspace_id, usage_count, usage_reset_date) values (v_ws, 0, public.next_reset_date());
  return v_ws;
end; $$;

-- Owner-only: invite someone by email. Supersedes any prior active invite for the
-- same email+workspace. Cannot invite as owner or invite an existing member.
create or replace function public.create_invitation(p_workspace_id uuid, p_invitee_email text, p_role public.workspace_member_role default 'developer')
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  if not public.is_workspace_owner(p_workspace_id) then raise exception 'only the workspace owner can invite'; end if;
  if p_role = 'owner' then raise exception 'cannot invite someone as owner'; end if;
  if exists (
    select 1 from workspace_members wm join app_users au on au.id = wm.user_id
    where wm.workspace_id = p_workspace_id and lower(au.email) = lower(p_invitee_email)
  ) then raise exception 'that user is already a member of this workspace'; end if;

  update workspace_invitations set status = 'revoked'
    where workspace_id = p_workspace_id and lower(invitee_email) = lower(p_invitee_email) and status = 'active';

  insert into workspace_invitations (workspace_id, inviter_user_id, invitee_email, invitee_role)
    values (p_workspace_id, v_uid, p_invitee_email, p_role)
    returning id into v_id;
  return v_id;
end; $$;

-- Invitee accepts: validates active + unexpired + email match, then adds membership.
create or replace function public.accept_invitation(p_invitation_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_email text; v_inv public.workspace_invitations;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  perform public.ensure_provisioned(v_uid);
  v_email := (select auth.email());

  select * into v_inv from workspace_invitations where id = p_invitation_id;
  if v_inv.id is null then raise exception 'invitation not found'; end if;
  if v_inv.status <> 'active' then raise exception 'invitation is no longer active'; end if;
  if v_inv.expires_at <= now() then
    update workspace_invitations set status = 'revoked' where id = p_invitation_id;
    raise exception 'invitation has expired';
  end if;
  if lower(coalesce(v_email, '')) <> lower(v_inv.invitee_email) then
    raise exception 'this invitation is for a different email address';
  end if;

  insert into workspace_members (workspace_id, user_id, role)
    values (v_inv.workspace_id, v_uid, v_inv.invitee_role)
    on conflict (workspace_id, user_id) do update set role = excluded.role;
  update workspace_invitations set status = 'accepted', invitee_user_id = v_uid where id = p_invitation_id;
  return v_inv.workspace_id;
end; $$;

-- Invitee declines their own invitation.
create or replace function public.decline_invitation(p_invitation_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_email text; v_inv public.workspace_invitations;
begin
  v_email := (select auth.email());
  select * into v_inv from workspace_invitations where id = p_invitation_id;
  if v_inv.id is null then raise exception 'invitation not found'; end if;
  if lower(coalesce(v_email, '')) <> lower(v_inv.invitee_email) then raise exception 'not your invitation'; end if;
  update workspace_invitations set status = 'declined', invitee_user_id = v_uid
    where id = p_invitation_id and status = 'active';
end; $$;

-- Owner revokes a pending invitation.
create or replace function public.revoke_invitation(p_invitation_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_inv public.workspace_invitations;
begin
  select * into v_inv from workspace_invitations where id = p_invitation_id;
  if v_inv.id is null then raise exception 'invitation not found'; end if;
  if not public.is_workspace_owner(v_inv.workspace_id) then raise exception 'only the workspace owner can revoke'; end if;
  update workspace_invitations set status = 'revoked' where id = p_invitation_id and status = 'active';
end; $$;

-- Every workspace the caller belongs to, with their role + the workspace's plan.
create or replace function public.list_my_workspaces()
returns table (workspace_id uuid, name text, is_personal boolean, role public.workspace_member_role, plan text)
language sql stable security definer set search_path = public as $$
  select w.id, w.name, w.is_personal, wm.role, public.workspace_plan(w.id)
  from workspaces w
  join workspace_members wm on wm.workspace_id = w.id
  where wm.user_id = auth.uid()
  order by w.is_personal desc, w.created_at
$$;

-- Members of a workspace (any member of that workspace may view).
create or replace function public.get_workspace_members(p_workspace_id uuid)
returns table (user_id uuid, email text, role public.workspace_member_role, added_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_workspace_member(p_workspace_id) then raise exception 'not a member of this workspace'; end if;
  return query
    select au.id, au.email, wm.role, wm.added_at
    from workspace_members wm
    join app_users au on au.id = wm.user_id
    where wm.workspace_id = p_workspace_id
    order by wm.role, wm.added_at;
end; $$;

-- The caller's active, unexpired invitations, matched by JWT email.
create or replace function public.get_my_pending_invitations()
returns table (id uuid, workspace_id uuid, workspace_name text, inviter_email text, invitee_role public.workspace_member_role, created_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select inv.id, inv.workspace_id, w.name, iu.email, inv.invitee_role, inv.created_at, inv.expires_at
  from workspace_invitations inv
  join workspaces w on w.id = inv.workspace_id
  left join app_users iu on iu.id = inv.inviter_user_id
  where inv.status = 'active'
    and inv.expires_at > now()
    and lower(inv.invitee_email) = lower(coalesce((select auth.email()), ''))
  order by inv.created_at desc
$$;

-- Owner removes a member (cannot remove an owner). Clears the removed user's
-- active-workspace pointer if it pointed here.
create or replace function public.remove_member(p_workspace_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_workspace_owner(p_workspace_id) then raise exception 'only the workspace owner can remove members'; end if;
  if exists (select 1 from workspace_members where workspace_id = p_workspace_id and user_id = p_user_id and role = 'owner') then
    raise exception 'cannot remove the workspace owner';
  end if;
  delete from workspace_members where workspace_id = p_workspace_id and user_id = p_user_id;
  update app_users set active_workspace_id = null where id = p_user_id and active_workspace_id = p_workspace_id;
end; $$;

-- A non-owner member leaves a team workspace (cannot leave a personal workspace or
-- as the owner). Clears the caller's active-workspace pointer if it pointed here.
create or replace function public.leave_workspace(p_workspace_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if exists (select 1 from workspaces where id = p_workspace_id and is_personal) then
    raise exception 'cannot leave your personal workspace';
  end if;
  if public.is_workspace_owner(p_workspace_id) then
    raise exception 'the owner cannot leave; transfer ownership or delete the workspace';
  end if;
  delete from workspace_members where workspace_id = p_workspace_id and user_id = v_uid;
  update app_users set active_workspace_id = null where id = v_uid and active_workspace_id = p_workspace_id;
end; $$;

-- Set the caller's active workspace (must be a member of it).
create or replace function public.set_active_workspace(p_workspace_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.is_workspace_member(p_workspace_id) then raise exception 'not a member of this workspace'; end if;
  update app_users set active_workspace_id = p_workspace_id where id = v_uid;
end; $$;
