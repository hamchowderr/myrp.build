/**
 * Build provenance — `__APP_*__` are injected at build time by
 * electron.vite.config.ts `define`. Surfaced in the UI (Settings + auth footer)
 * so a STALE packaged build is obvious at a glance: if the commit/time don't
 * match what you just built, you're looking at an old artifact, not your change.
 * See .claude/rules/dev-vs-prod.md.
 *
 * The `typeof` guards keep this safe where `define` isn't applied (e.g. vitest).
 */
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __BUILD_TIME__: string;

const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";
const APP_COMMIT = typeof __APP_COMMIT__ !== "undefined" ? __APP_COMMIT__ : "local";
const BUILD_TIME = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "";

/** e.g. "v0.1.0 · a1b2c3d · 6/3/2026, 10:42 AM" (or "· dev" when unbuilt). */
export function buildLabel(): string {
  const when = BUILD_TIME ? new Date(BUILD_TIME).toLocaleString() : "dev";
  return `v${APP_VERSION} · ${APP_COMMIT} · ${when}`;
}
