/**
 * Electron-free logger for the agent + tools (fivem-studio-studio-decouple).
 *
 * Mastra's recommended Electron structure keeps the agent code free of Electron
 * imports so `mastra dev` / Studio (and the eval/AIMock harnesses) can bundle and
 * run it as a separate process. Importing `electron-log/main` directly broke that
 * — the Mastra/esbuild bundler emitted an invalid Windows specifier
 * (`electron-log\main.js`) and crashed `mastra dev`.
 *
 * So `src/main/mastra/**` logs through THIS module, which defaults to `console`.
 * The Electron main process injects electron-log at startup via `setLogger(...)`,
 * so the packaged app keeps its file transport; outside Electron (Studio, tests)
 * it harmlessly falls back to console. No static electron-log dependency here.
 */
type LogFn = (...args: unknown[]) => void;

export interface Logger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  debug: LogFn;
}

let impl: Logger = console;

/** Electron main calls this once at startup to route agent logs to electron-log. */
export function setLogger(logger: Logger): void {
  impl = logger;
}

/** Stable façade — call sites keep a fixed reference even if the impl is swapped. */
const log: Logger = {
  info: (...args) => impl.info(...args),
  warn: (...args) => impl.warn(...args),
  error: (...args) => impl.error(...args),
  debug: (...args) => impl.debug(...args),
};

export default log;
