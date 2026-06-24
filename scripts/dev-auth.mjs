// `npm run dev:auth` — run the app in dev on the PROD auth path (Discord sign-in
// + billing) instead of the dev-bypass, so CustomAuth / SubscriptionSection render
// with HMR against local Supabase. Sets FIVEM_STUDIO_FORCE_AUTH=1, which
// electron.vite.config.ts reads to force __DEV_BYPASS__ = false.
// See .claude/rules/dev-vs-prod.md.
import { spawn } from "node:child_process";

spawn("npx", ["electron-vite", "dev"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, FIVEM_STUDIO_FORCE_AUTH: "1" },
}).on("exit", (code) => process.exit(code ?? 0));
