import { execSync } from "node:child_process";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { visualizer } from "rollup-plugin-visualizer";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Load .env (all keys — prefix "") so we can bake a FEW build-time-constant,
  // NON-SECRET values into the packaged main process. `.env` is excluded from the
  // electron-builder package, and these are read via process.env in main, so the
  // signed build would otherwise have them undefined (oxr).
  //
  // SAFE TO INLINE: PROXY_BASE_URL is the public Supabase edge-function URL, and
  // the Supabase anon key is a publishable, RLS-protected key meant to ship to
  // clients. The gateway/Anthropic keys live ONLY in the edge function and are
  // NEVER inlined. We also do NOT inline ANTHROPIC_API_KEY / FIVEM_STUDIO_DEV —
  // those stay runtime-only so the dev/owner bypass never leaks into a package.
  const env = loadEnv(mode, process.cwd(), "");

  // Prod-build env hygiene. Prod values live in Infisical
  // (otaku-internal / env=prod / path=/myrp-build) and are injected at build
  // time by wrapping the build with `infisical run ...` (see package.json
  // scripts build:prod / build:win / build:unpack:nosign). If the wrapper is
  // missing, Vite's loadEnv falls back to the local `.env` — which has dev
  // values — and the packaged renderer would silently ship the local Supabase
  // URL. Catch that early with a hard error pointing at the right command.
  if (mode === "production") {
    const supaUrl = env.VITE_SUPABASE_URL ?? "";
    if (!supaUrl.startsWith("https://")) {
      const hint =
        "Prod build needs prod env vars from Infisical. Wrap the build with:\n" +
        "  infisical run --projectId e56e0da5-6460-4bab-bdd6-2fd12ac5447b --env prod --path /myrp-build --recursive -- <build cmd>\n" +
        "Or use the prepared scripts: `npm run build:prod`, `npm run build:win`, `npm run build:unpack:nosign`.";
      throw new Error(
        `Production build refusing to start: dev-mode env values detected (VITE_SUPABASE_URL=${supaUrl}).\n${hint}`,
      );
    }
  }
  const mainDefine: Record<string, string> = {};
  if (env.PROXY_BASE_URL) {
    mainDefine["process.env.PROXY_BASE_URL"] = JSON.stringify(env.PROXY_BASE_URL);
  }
  const anonKey = env.VITE_SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY;
  if (anonKey) {
    mainDefine["process.env.VITE_SUPABASE_ANON_KEY"] = JSON.stringify(anonKey);
  }
  // Main's cloud Mastra memory adapter (M2/M3) builds its supabase-js client from
  // the Supabase URL + anon key — both publishable, RLS-protected values that are
  // safe to ship (same policy as the anon key above). Without this the packaged
  // main process has no URL at runtime and silently degrades to no-cloud-memory.
  // (M3.4 — pulled forward so M2 cloud memory works in a build.)
  const supaUrl = env.VITE_SUPABASE_URL ?? env.SUPABASE_URL;
  if (supaUrl) {
    mainDefine["process.env.VITE_SUPABASE_URL"] = JSON.stringify(supaUrl);
  }

  // Build-time bypass literal (hardening). `true` ONLY when
  // electron-vite is running in dev/preview mode AND FIVEM_STUDIO_DEV=1 is set
  // in .env at build time. Every packaged build inlines the literal `false`, so
  // the bypass branch + env reads + dev account path are physically removed
  // from the shipped main/preload bundles (verify: grep __DEV_BYPASS__ out/main/index.js).
  // FIVEM_STUDIO_FORCE_AUTH=1 (set by `npm run dev:auth`) forces the prod auth
  // path in dev so CustomAuth/SubscriptionSection render with HMR. Read straight
  // from process.env — NOT loadEnv, which reads the .env file where
  // FIVEM_STUDIO_DEV=1 lives. See .claude/rules/dev-vs-prod.md.
  const forceAuth = process.env.FIVEM_STUDIO_FORCE_AUTH === "1";
  const devBypassLiteral = JSON.stringify(
    mode === "development" && env.FIVEM_STUDIO_DEV === "1" && !forceAuth,
  );
  mainDefine.__DEV_BYPASS__ = devBypassLiteral;
  const preloadDefine: Record<string, string> = { __DEV_BYPASS__: devBypassLiteral };

  // Build-provenance stamp — surfaced in the UI (Settings + auth footer) so a
  // stale packaged build is obvious at a glance. See .claude/rules/dev-vs-prod.md.
  let appCommit = "local";
  try {
    appCommit = execSync("git rev-parse --short HEAD", { cwd: process.cwd() }).toString().trim();
  } catch {
    // not a git checkout — leave "local"
  }
  const provenanceDefine: Record<string, string> = {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.1.0"),
    __APP_COMMIT__: JSON.stringify(appCommit),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  };

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define: mainDefine,
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      define: preloadDefine,
    },
    renderer: {
      // The renderer's Vite root is `src/renderer/`, so envDir defaults to that
      // folder too — which means `.env`, `.env.production`, etc. at the PROJECT
      // root are invisible to the renderer build. Without this, the renderer
      // would bake in stale/empty values for VITE_SUPABASE_URL,
      // VITE_SUPABASE_ANON_KEY, etc., regardless of build mode. Point envDir at the
      // project root so the renderer sees the same .env files as main/preload.
      envDir: process.cwd(),
      define: provenanceDefine,
      resolve: {
        alias: {
          "@renderer": resolve("src/renderer/src"),
        },
      },
      plugins: [
        react(),
        tailwindcss(),
        // Bundle treemap for perf work — opt-in: `ANALYZE=1 npm run build` writes
        // out/renderer/bundle-stats.html (open it to inspect what's in index.js).
        ...(process.env.ANALYZE
          ? [
              visualizer({
                filename: "out/renderer/bundle-stats.html",
                template: "treemap",
                gzipSize: true,
              }),
            ]
          : []),
      ],
    },
  };
});
