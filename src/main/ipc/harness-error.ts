/**
 * Make harness error events READABLE across the IPC boundary (myrp-build-3yw).
 *
 * A FULL-lane run failed and the renderer received `{"type":"error","error":{}}`
 * — no message, no stack — and the main-process log had nothing either. The cause
 * is structured cloning: `webContents.send` clones the event, and an `Error`
 * instance nested inside a plain object loses `message`/`name`/`stack` because
 * those are NON-ENUMERABLE own properties. It arrives as `{}`.
 *
 * That is a diagnosis blocker, not cosmetics. It makes "that error did not
 * happen" unprovable (myrp-build-9h1 could not be closed for exactly this
 * reason: searching destroyed text for a phrase proves nothing) and it shows the
 * user a failed generation with no reason.
 *
 * Our OWN error sends already stringify (`err instanceof Error ? err.message`).
 * This covers the events forwarded RAW from the Mastra session, which we do not
 * construct and whose shape we do not control.
 */
import log from "electron-log/main";

/** A plain, clone-safe error payload. */
export interface ReadableErrorPayload {
  message: string;
  name?: string;
  stack?: string;
  code?: string;
}

/** Pull a readable payload out of whatever an event's `error` field holds. */
function toPayload(raw: unknown): ReadableErrorPayload {
  if (raw instanceof Error) {
    const { message, name, stack } = raw;
    const code = (raw as { code?: unknown }).code;
    return {
      message: message || name || "Error (no message)",
      name,
      ...(stack ? { stack } : {}),
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  if (typeof raw === "string") return { message: raw };
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    // Some producers nest the real error one level down.
    const inner = o.error ?? o.cause;
    if (inner && inner !== raw) return toPayload(inner);
    const message = typeof o.message === "string" ? o.message : undefined;
    if (message) {
      return {
        message,
        ...(typeof o.name === "string" ? { name: o.name } : {}),
        ...(typeof o.stack === "string" ? { stack: o.stack } : {}),
        ...(typeof o.code === "string" ? { code: o.code } : {}),
      };
    }
    // An object with nothing readable — say so explicitly rather than forwarding
    // `{}`, which is what made this class of failure invisible.
    const keys = Object.keys(o);
    return {
      message: keys.length
        ? `Unreadable error payload (keys: ${keys.join(", ")})`
        : "Unreadable error payload (empty object — likely an Error lost across IPC)",
    };
  }
  if (raw === undefined || raw === null) return { message: "Unknown error (no payload)" };
  return { message: String(raw) };
}

/**
 * Normalise an error-bearing harness event so its payload survives IPC, and log
 * it in main. Non-error events pass through UNTOUCHED and unwrapped — this sits
 * on the hot path for every event of every run.
 */
export function readableError<T extends { type?: string }>(event: T): T {
  if (event?.type !== "error") return event;
  const payload = toPayload((event as { error?: unknown }).error);
  // Also surface it in main: the 3yw run left no trace in the main log either.
  log.error(`[harness] ${payload.message}${payload.stack ? `\n${payload.stack}` : ""}`);
  return { ...event, error: payload };
}
