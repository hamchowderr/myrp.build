-- Grant SELECT on the mastra memory tables to the authenticated role.
--
-- The mastra_memory migration (20260605203800) enabled RLS and created
-- "read ws mastra threads/messages" SELECT policies, but never granted the role
-- table-level access. In Postgres, RLS only FILTERS rows — the role still needs a
-- table-level GRANT or every read fails with `42501 permission denied for table`
-- BEFORE the policy is even evaluated. Result: thread/message reads (listThreads,
-- the Harness turn) 42501'd for the per-run JWT (role `authenticated`).
--
-- Writes go through SECURITY DEFINER RPCs (mastra_save_*, mastra_update_thread, …)
-- which run as the owner, so NO insert/update/delete grant is needed here — reads
-- only, matching the existing RLS SELECT policies.

grant select on public.mastra_threads to authenticated, anon;
grant select on public.mastra_messages to authenticated, anon;
grant select on public.mastra_message_embeddings to authenticated, anon;
grant select on public.mastra_observational_memory to authenticated, anon;
grant select on public.mastra_resources to authenticated, anon;
