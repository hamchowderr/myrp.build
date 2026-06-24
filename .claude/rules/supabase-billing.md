---
paths:
  - "supabase/**"
  - "src/renderer/src/AuthApp.tsx"
  - "src/renderer/src/screens/settings/SubscriptionSection.tsx"
---
# Auth, billing & the inference proxy

Auth is **native Supabase Auth (Discord OAuth, PKCE)** — Clerk was removed (Phase 6); don't reintroduce it. ONE Supabase Postgres holds Mastra memory + RAG vectors + billing.

## Plan / usage model
- Plans + monthly limits (`plan_limit()`): `free` 10, `starter` 100, `pro` 500, `studio` 2500.
- `workspace_plan(ws)` → the workspace's active-subscription plan (else `free`). `get_subscription()` (renderer, RLS by `auth.uid()`) and `get_user_workspace_plan()` (edge fn, service role) return plan + usage + `can_generate`.
- Quota gate: `supabase/functions/fivem-inference-proxy` checks `can_generate` (429 if over), proxies to the Vercel AI Gateway with OUR key, then fire-and-forgets `increment_usage`.
- Stripe checkout/portal/webhook are Deno edge functions (`create-checkout`, `create-portal`, `stripe-webhook`).

## Cloud Mastra memory (per-tenant, no creds in client)
The same cloud Supabase project stores agent chat **memory** + the **RAG** index. The Electron **main** process reads/writes it with **supabase-js (anon key + per-run JWT)** — the same secure pattern as `get_subscription`. **Reads** hit RLS-protected tables (`mastra_threads`/`mastra_messages`, gated by `is_workspace_member`); **writes** go through SECURITY DEFINER RPCs (`mastra_save_thread`/`save_messages`/…) that re-check membership and stamp identity from `auth.uid()`. RAG reads via the `match_ox_corpus` read RPC. `resourceId = ws_<ws>__srv_<srv>`. Workflow approval snapshots stay **local** (never cloud). Adapter: `src/main/mastra/storage/` (see `mastra-agents.md`). **Never ship a DB connection string** — only the anon key + `VITE_SUPABASE_URL` are publishable.

## Teams (multi-member workspaces)
Customers are teams. Roles = **Owner + Developer** (`workspace_member_role`; `admin` is defunct). Owner manages members + billing; Developer just builds. Invites are **in-app pending, no email infra**: `create_invitation` (owner, by email) → `workspace_invitations` row → invitee matched by `auth.email()` via `get_my_pending_invitations` → `accept_invitation`/`decline_invitation`. Active workspace = `app_users.active_workspace_id` (`set_active_workspace`/`list_my_workspaces`); `activeWorkspaceId` scopes **both** chat memory and billing. **Billing is per-workspace** — `get_subscription(p_workspace_id)`/checkout/portal act on the active workspace; **developers see read-only billing** (owner-only gate in UI + edge-fn 403). All mutations via SECURITY DEFINER RPCs that re-check `is_workspace_owner`/membership. UI: `src/renderer/src/components/team/*` + `WorkspaceSwitcher`.

## Rules
- **NEVER swallow billing errors.** A failed `create-checkout`/`create-portal` invoke in `AuthApp.tsx` must surface in the UI (toast/inline) — not just `console.error`. Silent failures read as dead buttons.
- The renderer Upgrade/Manage buttons are `disabled={!workspaceId}`; if `get_subscription` returns no row the buttons are inert. Don't assume "clicked, nothing happened" = backend error — it may be a disabled button.
- Edge functions read secrets from `supabase/functions/.env`, which the edge runtime loads **only at `supabase start`**. After editing it, run `supabase stop && supabase start` — a plain docker restart does NOT reload it.
- `window.open(url)` for Stripe is routed to the system browser by `setWindowOpenHandler` in main (`index.ts`); fine to use. The OAuth flow uses `window.api.openExternal`.
- Verify an edge fn: `deno check index.ts`, then `supabase functions serve <fn>` + curl.
- Never inline secrets into the client; only `VITE_SUPABASE_URL`/anon key + `PROXY_BASE_URL` are build-inlined. The owner's `ANTHROPIC_API_KEY` and gateway keys stay runtime-only.
