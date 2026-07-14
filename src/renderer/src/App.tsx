/**
 * Root router.
 *
 *  - DEV BYPASS (window.api.isDevBypass — owner runs on a local ANTHROPIC_API_KEY /
 *    FIVEM_STUDIO_DEV): render AppContent directly with the dev account stub. Supabase Auth
 *    and billing are NEVER imported, so they stay out of the startup bundle and
 *    local testing skips sign-in entirely.
 *  - PRODUCTION (no local key): lazy-load AuthApp, which pulls in Supabase Auth + billing
 *    and gates the app behind sign-in + usage/billing.
 */
import { ActiveThemeProvider } from "@renderer/components/active-theme";
import { Skeleton } from "@renderer/components/ui/skeleton";
import { Toaster } from "@renderer/components/ui/sonner";
import { DevAccountProvider } from "@renderer/lib/account";
import { lazy, Suspense } from "react";
import { AppContent } from "./AppContent";

const AuthApp = lazy(() => import("./AuthApp"));

function AuthLoading(): React.JSX.Element {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <Skeleton className="h-8 w-32 rounded-md" />
    </div>
  );
}

function App(): React.JSX.Element {
  return (
    <>
      {window.api.isDevBypass ? (
        <ActiveThemeProvider>
          <DevAccountProvider>
            <AppContent />
          </DevAccountProvider>
        </ActiveThemeProvider>
      ) : (
        <Suspense fallback={<AuthLoading />}>
          <AuthApp />
        </Suspense>
      )}
      {/* App-wide action feedback (Foreman-style) — covers dev + prod paths. */}
      <Toaster />
    </>
  );
}

export default App;
