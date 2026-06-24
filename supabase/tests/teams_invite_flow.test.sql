-- Integration test for the teams invite->accept flow (fivem-studio-v05).
-- Run locally:  supabase db query --local -f supabase/tests/teams_invite_flow.test.sql
-- One self-contained DO block: simulates two authenticated users via
-- request.jwt.claims (sub/email), exercises every management RPC + the key negative
-- authorization paths, asserts via RAISE EXCEPTION, then deletes its own test rows.
-- On any failed assertion the statement auto-rolls-back (no trace); a clean run
-- prints "TEAMS INVITE FLOW: ALL ASSERTIONS PASSED" and leaves the DB untouched.

do $$
declare
  v_owner    uuid := gen_random_uuid();
  v_invitee  uuid := gen_random_uuid();
  v_owner_email   text := 'owner@teamtest.local';
  v_invitee_email text := 'invitee@teamtest.local';
  v_owner_ws   uuid;
  v_invitee_ws uuid;
  v_ws   uuid;
  v_inv  uuid;
  v_cnt  int;
  v_active uuid;
  v_role public.workspace_member_role;
begin
  -- ── setup: two auth users (handle_new_user provisions personal ws + app_user) ──
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at,
                          raw_app_meta_data, raw_user_meta_data)
  values
    ('00000000-0000-0000-0000-000000000000', v_owner, 'authenticated', 'authenticated',
     v_owner_email, '', now(), now(), now(), '{}', '{}'),
    ('00000000-0000-0000-0000-000000000000', v_invitee, 'authenticated', 'authenticated',
     v_invitee_email, '', now(), now(), now(), '{}', '{}');

  v_owner_ws   := public.personal_workspace_id(v_owner);
  v_invitee_ws := public.personal_workspace_id(v_invitee);
  if v_owner_ws is null or v_invitee_ws is null then
    raise exception 'signup trigger did not provision personal workspaces';
  end if;

  -- ── as OWNER: create a team workspace ──────────────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner::text, 'email', v_owner_email)::text, true);

  v_ws := public.create_team_workspace('TEST_Team');
  if v_ws is null then raise exception 'create_team_workspace returned null'; end if;
  select role into v_role from workspace_members where workspace_id = v_ws and user_id = v_owner;
  if v_role <> 'owner' then raise exception 'creator should be owner, got %', v_role; end if;

  -- ── as OWNER: invite the developer ─────────────────────────────────────────
  v_inv := public.create_invitation(v_ws, v_invitee_email, 'developer');
  if v_inv is null then raise exception 'create_invitation returned null'; end if;
  select count(*) into v_cnt from workspace_invitations where workspace_id = v_ws and status = 'active';
  if v_cnt <> 1 then raise exception 'expected 1 active invitation, got %', v_cnt; end if;

  -- ── as INVITEE: see the pending invitation ─────────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_invitee::text, 'email', v_invitee_email)::text, true);
  select count(*) into v_cnt from public.get_my_pending_invitations() where id = v_inv;
  if v_cnt <> 1 then raise exception 'invitee should see exactly 1 pending invite, got %', v_cnt; end if;

  -- ── as INVITEE: accept ─────────────────────────────────────────────────────
  if public.accept_invitation(v_inv) <> v_ws then raise exception 'accept_invitation returned wrong workspace'; end if;
  select role into v_role from workspace_members where workspace_id = v_ws and user_id = v_invitee;
  if v_role <> 'developer' then raise exception 'accepted member should be developer, got %', v_role; end if;
  select count(*) into v_cnt from workspace_invitations
    where id = v_inv and status = 'accepted' and invitee_user_id = v_invitee;
  if v_cnt <> 1 then raise exception 'invitation should be accepted + stamped with invitee'; end if;

  -- ── as OWNER: workspace now has 2 members ──────────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner::text, 'email', v_owner_email)::text, true);
  select count(*) into v_cnt from public.get_workspace_members(v_ws);
  if v_cnt <> 2 then raise exception 'expected 2 members, got %', v_cnt; end if;

  -- ── as INVITEE: set + verify active workspace ──────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_invitee::text, 'email', v_invitee_email)::text, true);
  perform public.set_active_workspace(v_ws);
  select active_workspace_id into v_active from app_users where id = v_invitee;
  if v_active <> v_ws then raise exception 'active_workspace_id not set'; end if;

  -- ── NEGATIVE: a developer cannot invite ────────────────────────────────────
  begin
    perform public.create_invitation(v_ws, 'x@teamtest.local', 'developer');
    raise exception 'NEG_FAIL: developer was allowed to invite';
  exception when others then
    if sqlerrm like 'NEG_FAIL%' then raise; end if;
  end;

  -- ── NEGATIVE: cannot invite someone as owner ───────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner::text, 'email', v_owner_email)::text, true);
  begin
    perform public.create_invitation(v_ws, 'z@teamtest.local', 'owner');
    raise exception 'NEG_FAIL: invite-as-owner was allowed';
  exception when others then
    if sqlerrm like 'NEG_FAIL%' then raise; end if;
  end;

  -- ── NEGATIVE: owner cannot leave their own workspace ───────────────────────
  begin
    perform public.leave_workspace(v_ws);
    raise exception 'NEG_FAIL: owner was allowed to leave';
  exception when others then
    if sqlerrm like 'NEG_FAIL%' then raise; end if;
  end;

  -- ── as INVITEE: leave the workspace, active pointer clears ─────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_invitee::text, 'email', v_invitee_email)::text, true);
  perform public.leave_workspace(v_ws);
  select count(*) into v_cnt from workspace_members where workspace_id = v_ws and user_id = v_invitee;
  if v_cnt <> 0 then raise exception 'invitee should have left, still a member'; end if;
  select active_workspace_id into v_active from app_users where id = v_invitee;
  if v_active is not null then raise exception 'active_workspace_id should be cleared on leave'; end if;

  -- ── cleanup (success path): remove all test rows ───────────────────────────
  perform set_config('request.jwt.claims', '', true);
  delete from auth.users where id in (v_owner, v_invitee);                 -- cascades app_users + memberships
  delete from workspaces where id in (v_ws, v_owner_ws, v_invitee_ws);     -- cascades usage_counters + invitations

  raise notice 'TEAMS INVITE FLOW: ALL ASSERTIONS PASSED';
end $$;
