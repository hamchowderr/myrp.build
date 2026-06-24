/**
 * Persistent storage adapter for the renderer's Supabase Auth client
 * (fivem-studio-gvh). Clerk kept its session in memory only under
 * standardBrowser:false, so it died on reload/refresh. Supabase exposes a
 * pluggable `storage` interface (its documented React-Native/native pattern):
 * we back it with an ENCRYPTED file in the main process (safeStorage) over IPC,
 * so the session + PKCE code_verifier survive reload, the >60s token refresh,
 * and full app relaunch.
 *
 * Origin-independent (proxies to main), so it works under file:// (packaged)
 * and the dev server alike — no app:// protocol change needed.
 */
import type { SupportedStorage } from "@supabase/supabase-js";

export const ipcAuthStorage: SupportedStorage = {
  getItem: (key) => window.api.authStore.get(key),
  setItem: (key, value) => window.api.authStore.set(key, value),
  removeItem: (key) => window.api.authStore.remove(key),
};
