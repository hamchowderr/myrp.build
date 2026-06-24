/**
 * Discord-only sign-in UI for Electron (native Supabase Auth, PKCE).
 *
 * OAuth runs entirely in the user's system browser via the RFC 8252 native-app
 * pattern, because an Electron renderer can't host the provider redirect:
 *
 *   1. Click "Continue with Discord" → window.api.startDiscordSignIn() starts a
 *      one-shot 127.0.0.1 loopback server in main and returns its redirect URI.
 *   2. supabase.auth.signInWithOAuth({ provider:'discord', skipBrowserRedirect,
 *      redirectTo:<loopback> }) builds the authorize URL AND stores the PKCE
 *      code_verifier in our persistent storage adapter (so it's still there when
 *      we exchange, even across a reload).
 *   3. window.api.openExternal(url) opens it in the system browser. Discord →
 *      local Supabase /auth/v1/callback → redirect to the loopback with ?code=.
 *   4. Main captures ?code= and forwards it via onAuthSignInCode.
 *   5. supabase.auth.exchangeCodeForSession(code) → session persisted.
 *
 * AuthGate (AuthApp.tsx) listens via onAuthStateChange, so once the session is
 * set the app switches to AppContent automatically.
 *
 * The presentation is a dark, atmospheric "forge" scene (cyan Midnight Forge
 * theme) — aurora glow + dot grid + grain behind a glass card with a real
 * Discord-blurple action. Auth logic is unchanged from the prior version.
 */
import { buildLabel } from "@renderer/lib/build-info";
import { supabase } from "@renderer/lib/supabase";
import { AlertTriangle, Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface State {
  busy: boolean;
  error: string | null;
}

const initial: State = { busy: false, error: null };

function errMsg(err: unknown): string {
  if (!err) return "Something went wrong";
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const anyErr = err as { message?: string };
    if (anyErr.message) return anyErr.message;
  }
  return String(err);
}

/** Discord wordmark glyph (official logo path). */
function DiscordGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" role="img" className={className}>
      <title>Discord</title>
      <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.291.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

/** myRP.build mark — an isometric "build block" in a glowing cyan badge. */
function BrandMark() {
  return (
    <div className="rpa-mark">
      <svg viewBox="0 0 24 24" role="img" width="26" height="26">
        <title>myRP.build</title>
        <path d="M12 2.6 21 7.8 12 13 3 7.8 12 2.6Z" fill="currentColor" opacity="0.95" />
        <path d="M3 7.8 12 13v8.4L3 16.2V7.8Z" fill="currentColor" opacity="0.55" />
        <path d="M21 7.8 12 13v8.4l9-5.2V7.8Z" fill="currentColor" opacity="0.75" />
      </svg>
    </div>
  );
}

export function CustomAuth(): React.JSX.Element {
  const [s, setS] = useState<State>(initial);
  // Stable patch helper so the useEffect/useCallback below don't churn.
  const set = useMemo(() => (patch: Partial<State>) => setS((cur) => ({ ...cur, ...patch })), []);

  // Receive the OAuth code captured by the main process's loopback server after
  // Discord completes in the system browser, and exchange it for a session.
  useEffect(() => {
    return window.api.onAuthSignInCode(async (code) => {
      if (!supabase) {
        set({ busy: false, error: "Auth is not configured." });
        return;
      }
      try {
        console.warn("[auth] received OAuth code, exchanging for session");
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          set({ busy: false, error: errMsg(error) });
          return;
        }
        // Session is now persisted; AuthGate's onAuthStateChange re-renders to
        // AppContent. Leave busy=true so the UI stays settled during the flip.
      } catch (err) {
        console.error("[auth] code exchange failed", err);
        set({ busy: false, error: errMsg(err) });
      }
    });
  }, [set]);

  const handleOAuth = useCallback(async () => {
    if (!supabase) {
      set({ error: "Auth is not configured." });
      return;
    }
    set({ busy: true, error: null });
    try {
      // Main starts the loopback and returns its redirect URI. signInWithOAuth then
      // builds the authorize URL and stores the PKCE verifier; we open it in the
      // system browser. The code returns via onAuthSignInCode above.
      const redirectTo = await window.api.startDiscordSignIn();
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "discord",
        options: { skipBrowserRedirect: true, redirectTo },
      });
      if (error || !data?.url) throw error ?? new Error("No authorize URL returned.");
      await window.api.openExternal(data.url);
    } catch (err) {
      console.error("[auth] startDiscordSignIn failed", err);
      set({ busy: false, error: errMsg(err) });
    }
  }, [set]);

  return (
    <div className="rpa-root">
      <style>{styles}</style>

      {/* Atmosphere: aurora glows, dot grid, grain, vignette. */}
      <div className="rpa-aurora rpa-aurora-1" />
      <div className="rpa-aurora rpa-aurora-2" />
      <div className="rpa-grid" />
      <div className="rpa-grain" />
      <div className="rpa-vignette" />

      <main className="rpa-card">
        <span className="rpa-card-edge" />

        <div className="rpa-head" style={{ animationDelay: "40ms" }}>
          <BrandMark />
          <div className="rpa-wordmark">
            <span className="rpa-word">
              myRP<span className="rpa-word-accent">.build</span>
            </span>
            <span className="rpa-kicker">AI RESOURCE FORGE</span>
          </div>
        </div>

        <div className="rpa-copy" style={{ animationDelay: "120ms" }}>
          <h1 className="rpa-title">
            {s.busy ? "Complete sign-in in your browser" : "Sign in to start building"}
          </h1>
          <p className="rpa-sub">
            {s.busy
              ? "We opened Discord in your browser. Authorize there, then come right back — this window updates on its own."
              : "Continue with Discord to generate production-ready FiveM resources — scripts, manifests, SQL and NUI, written straight to disk."}
          </p>
        </div>

        <div className="rpa-action" style={{ animationDelay: "200ms" }}>
          <button
            type="button"
            className="rpa-discord"
            onClick={() => handleOAuth()}
            disabled={s.busy}
            data-busy={s.busy}
          >
            <span className="rpa-discord-glow" />
            {s.busy ? (
              <Loader2 className="rpa-ico rpa-spin" strokeWidth={2.5} />
            ) : (
              <DiscordGlyph className="rpa-ico" />
            )}
            <span>{s.busy ? "Waiting for Discord…" : "Continue with Discord"}</span>
          </button>

          {s.busy ? (
            <button
              type="button"
              className="rpa-cancel"
              onClick={() => set({ busy: false, error: null })}
            >
              Cancel and try again
            </button>
          ) : null}
        </div>

        {s.error ? (
          <div className="rpa-error" role="alert" style={{ animationDelay: "0ms" }}>
            <AlertTriangle className="rpa-error-ico" />
            <span>{s.error}</span>
          </div>
        ) : null}

        <div className="rpa-foot" style={{ animationDelay: "300ms" }}>
          <ShieldCheck className="rpa-foot-ico" />
          <span>We only use Discord to know it's you. Nothing gets posted.</span>
        </div>

        <div className="rpa-build">{buildLabel()}</div>
      </main>
    </div>
  );
}

/* Component-scoped styles. Dark "Midnight Forge" scene; cyan accent pulled from
   the app theme (--primary) with explicit fallbacks so the scene reads dark
   regardless of the active light/dark preset. */
const styles = `
.rpa-root {
  position: fixed; inset: 0; overflow: hidden;
  display: grid; place-items: center;
  background:
    radial-gradient(120% 80% at 50% -10%, #0d1822 0%, #07090e 55%, #05060a 100%);
  --rpa-cyan: var(--primary, oklch(0.72 0.14 192));
  --rpa-blurple: #5865f2;
  font-family: var(--font-sans, "Geist Sans", system-ui, sans-serif);
  -webkit-user-select: none; user-select: none;
}
.rpa-aurora { position: absolute; border-radius: 50%; filter: blur(70px); opacity: 0.5; pointer-events: none; }
.rpa-aurora-1 {
  width: 620px; height: 620px; top: -240px; left: 50%; margin-left: -310px;
  background: radial-gradient(circle, color-mix(in oklch, var(--rpa-cyan) 60%, transparent) 0%, transparent 68%);
  animation: rpa-float-a 14s ease-in-out infinite;
}
.rpa-aurora-2 {
  width: 520px; height: 520px; bottom: -220px; right: -120px;
  background: radial-gradient(circle, color-mix(in oklch, var(--rpa-blurple) 45%, transparent) 0%, transparent 70%);
  opacity: 0.35; animation: rpa-float-b 18s ease-in-out infinite;
}
.rpa-grid {
  position: absolute; inset: 0; pointer-events: none;
  background-image: radial-gradient(circle, rgba(120,170,200,0.16) 1px, transparent 1px);
  background-size: 22px 22px;
  -webkit-mask-image: radial-gradient(110% 90% at 50% 35%, #000 0%, transparent 72%);
          mask-image: radial-gradient(110% 90% at 50% 35%, #000 0%, transparent 72%);
}
.rpa-grain { position: absolute; inset: 0; pointer-events: none; opacity: 0.035; mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
.rpa-vignette { position: absolute; inset: 0; pointer-events: none;
  box-shadow: inset 0 0 200px 40px rgba(0,0,0,0.6); }

.rpa-card {
  position: relative; z-index: 1; width: 416px; max-width: calc(100vw - 48px);
  padding: 38px 36px 30px;
  border-radius: 20px;
  background: linear-gradient(180deg, rgba(22,26,34,0.78), rgba(13,16,22,0.82));
  border: 1px solid rgba(140,180,205,0.10);
  -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px);
  box-shadow:
    0 1px 0 0 rgba(255,255,255,0.04) inset,
    0 30px 80px -30px rgba(0,0,0,0.85),
    0 0 60px -20px color-mix(in oklch, var(--rpa-cyan) 30%, transparent);
  animation: rpa-rise 0.6s cubic-bezier(0.22,1,0.36,1) both;
}
.rpa-card-edge {
  position: absolute; inset: 0 0 auto 0; height: 1px; border-radius: 20px 20px 0 0;
  background: linear-gradient(90deg, transparent, color-mix(in oklch, var(--rpa-cyan) 70%, transparent), transparent);
  opacity: 0.7;
}

.rpa-head { display: flex; align-items: center; justify-content: center; gap: 13px; animation: rpa-rise 0.55s cubic-bezier(0.22,1,0.36,1) both; }
.rpa-mark {
  display: grid; place-items: center; width: 46px; height: 46px; border-radius: 13px; flex: none;
  color: #06121a;
  background: linear-gradient(150deg, color-mix(in oklch, var(--rpa-cyan) 92%, white) 0%, var(--rpa-cyan) 55%, color-mix(in oklch, var(--rpa-cyan) 70%, black) 100%);
  box-shadow: 0 0 22px -2px color-mix(in oklch, var(--rpa-cyan) 55%, transparent), 0 4px 12px -4px rgba(0,0,0,0.6);
}
.rpa-wordmark { display: flex; flex-direction: column; gap: 3px; }
.rpa-word { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; color: #eef3f6; line-height: 1; }
.rpa-word-accent { color: var(--rpa-cyan); }
.rpa-kicker {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 9.5px; letter-spacing: 0.28em; color: rgba(150,175,190,0.6); text-transform: uppercase;
}

.rpa-copy { margin-top: 28px; text-align: center; animation: rpa-rise 0.55s cubic-bezier(0.22,1,0.36,1) both; }
.rpa-title { font-size: 22px; line-height: 1.2; font-weight: 600; letter-spacing: -0.01em; color: #f2f5f7; margin: 0; }
.rpa-sub { margin: 10px 0 0; font-size: 13.5px; line-height: 1.6; color: rgba(176,196,208,0.78); }

.rpa-action { margin-top: 26px; display: flex; flex-direction: column; gap: 12px; animation: rpa-rise 0.55s cubic-bezier(0.22,1,0.36,1) both; }
.rpa-discord {
  position: relative; overflow: hidden;
  display: flex; align-items: center; justify-content: center; gap: 11px;
  height: 50px; width: 100%; border: 0; border-radius: 13px; cursor: pointer;
  font-family: inherit; font-size: 15px; font-weight: 600; color: #fff;
  background: linear-gradient(180deg, #5e6bff 0%, var(--rpa-blurple) 48%, #4853d6 100%);
  box-shadow: 0 8px 20px -8px rgba(88,101,242,0.7), 0 1px 0 0 rgba(255,255,255,0.18) inset;
  transition: transform 0.16s ease, box-shadow 0.2s ease, filter 0.2s ease;
}
.rpa-discord:hover:not(:disabled) { transform: translateY(-1.5px); box-shadow: 0 14px 30px -10px rgba(88,101,242,0.8), 0 1px 0 0 rgba(255,255,255,0.22) inset; }
.rpa-discord:active:not(:disabled) { transform: translateY(0); }
.rpa-discord:disabled { cursor: default; filter: saturate(0.7) brightness(0.92); }
.rpa-discord-glow { position: absolute; inset: 0; background: radial-gradient(60% 140% at 50% -30%, rgba(255,255,255,0.28), transparent 70%); pointer-events: none; }
.rpa-ico { width: 21px; height: 21px; flex: none; }
.rpa-spin { animation: rpa-spin 0.9s linear infinite; }

.rpa-cancel {
  align-self: center; background: none; border: 0; cursor: pointer; padding: 4px 8px;
  font-family: inherit; font-size: 12.5px; color: rgba(160,180,195,0.65);
  transition: color 0.15s ease;
}
.rpa-cancel:hover { color: #d6e2ea; }

.rpa-error {
  display: flex; align-items: flex-start; justify-content: center; gap: 9px; margin-top: 16px; padding: 11px 13px;
  border-radius: 11px; font-size: 12.5px; line-height: 1.5;
  color: #ffb4b4; background: rgba(220,40,40,0.10); border: 1px solid rgba(220,60,60,0.22);
  animation: rpa-rise 0.3s ease both;
}
.rpa-error-ico { width: 15px; height: 15px; flex: none; margin-top: 1px; }

.rpa-foot {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  margin-top: 26px; padding-top: 18px; border-top: 1px solid rgba(140,180,205,0.08);
  font-size: 11.5px; color: rgba(140,165,180,0.55);
  animation: rpa-rise 0.55s cubic-bezier(0.22,1,0.36,1) both;
}
.rpa-foot-ico { width: 13px; height: 13px; color: color-mix(in oklch, var(--rpa-cyan) 80%, white); }
.rpa-mono { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 10.5px; letter-spacing: 0.02em; color: rgba(160,185,200,0.7); }
.rpa-build { margin-top: 10px; text-align: center; font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 9px; letter-spacing: 0.02em; color: rgba(150,175,190,0.38); }

@keyframes rpa-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes rpa-spin { to { transform: rotate(360deg); } }
@keyframes rpa-float-a { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-26px,18px) scale(1.06); } }
@keyframes rpa-float-b { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(22px,-16px) scale(1.08); } }

@media (prefers-reduced-motion: reduce) {
  .rpa-aurora, .rpa-spin { animation: none !important; }
  .rpa-card, .rpa-head, .rpa-copy, .rpa-action, .rpa-foot, .rpa-error { animation: none !important; opacity: 1 !important; transform: none !important; }
}
`;
