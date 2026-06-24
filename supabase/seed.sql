-- Dev-only seed: a deterministic local Supabase user (fivem-studio-v1f9).
--
-- WHY: in dev-bypass the Electron main process needs a real local-Supabase
-- session JWT so chat memory uses the SAME SupabaseMemoryStorage adapter as
-- prod (anon key + JWT + RLS) instead of the retired PostgresStore. This user is
-- signed in by src/main/mastra/storage/dev-auth.ts.
--
-- SAFE: local-only (127.0.0.1), throwaway password, never ships (the dev path is
-- DCE'd out of packaged builds via __DEV_BYPASS__). The on_auth_user_created
-- trigger (handle_new_user → ensure_provisioned) auto-creates this user's
-- app_users row + personal workspace + owner membership + usage_counters, so
-- RLS reads and the SECURITY DEFINER write RPCs succeed. Idempotent.

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data,
  is_sso_user,
  is_anonymous,
  -- GoTrue scans these as non-null strings; NULL → "Database error querying schema".
  confirmation_token,
  recovery_token,
  email_change,
  email_change_token_new,
  email_change_token_current,
  phone_change,
  phone_change_token,
  reauthentication_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-1111-1111-111111111111',
  'authenticated',
  'authenticated',
  'dev@myrp.build',
  crypt('devpassword', gen_salt('bf')),
  now(),
  now(),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{}',
  false,
  false,
  '', '', '', '', '', '', '', ''
) on conflict (id) do nothing;

-- Email identity row (required for password sign-in in current GoTrue).
insert into auth.identities (
  id,
  user_id,
  provider_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
) values (
  gen_random_uuid(),
  '11111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111111',
  '{"sub":"11111111-1111-1111-1111-111111111111","email":"dev@myrp.build","email_verified":true}',
  'email',
  now(),
  now(),
  now()
) on conflict (provider_id, provider) do nothing;
