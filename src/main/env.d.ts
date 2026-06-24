/**
 * Ambient declarations for build-time literals injected by Vite (electron.vite.config.ts).
 * These are NOT runtime values — they're string substitutions performed at build time so the
 * minifier can DCE branches keyed on them.
 */

/**
 * Dev-mode bypass literal. `true` ONLY when `electron-vite dev|preview` is running AND
 * .env has FIVEM_STUDIO_DEV=1. In every packaged build this is the literal `false`, so any
 * branch gated on it is removed from out/main/index.js (and out/preload/index.js). The same
 * literal is also injected into the preload bundle.
 */
declare const __DEV_BYPASS__: boolean;
