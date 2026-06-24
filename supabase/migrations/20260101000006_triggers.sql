-- ── Clean baseline 06: triggers ──────────────────────────────────────────────
-- Auto-provision on Supabase Auth signup. This trigger lives on auth.users, which
-- is OUTSIDE the `--schema public` drift-check — verify it explicitly after a
-- repave:  select tgname from pg_trigger
--          where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created';
-- The self-healing read RPCs (get_subscription / get_user_workspace_plan) are the
-- belt-and-suspenders if this trigger ever fails to fire on a hosted rebuild.

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
