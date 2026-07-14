/**
 * Server-side <turn> attribution + working-memory participants template for
 * shared team threads.
 *
 * Teams share ONE Mastra thread per workspace+server (resourceId =
 * `ws_<ws>__srv_<srv>`). Because every member's messages land in the same thread,
 * each USER message is tagged in the Electron MAIN process with a <turn> element
 * built ENTIRELY from the authenticated JWT identity (auth.uid()/auth.email(),
 * resolved via getUser()) + the member's workspace_members.role (resolved via the
 * my_workspace_role RPC). Nothing here comes from a client-supplied arg, so
 * attribution cannot be spoofed by a tampered renderer.
 *
 * The tag is prepended to the user's text so it is stored verbatim in
 * mastra_messages (durable attribution) AND visible to the model (it can address
 * the right teammate). The model is told about the convention via the WM
 * participants template, which Mastra keeps in the thread's metadata
 * (scope:'thread') and folds into the system message.
 */

/** Identity needed to attribute a turn — all from the authenticated session. */
export interface TurnIdentity {
  /** auth.uid() — the Supabase user id. */
  authorId: string;
  /** Display name: auth user_metadata name/full_name, else the email local-part. */
  authorName: string;
  /** workspace_members.role for the active workspace ('owner'|'admin'|'developer'). */
  functionalRole: string;
}

/** Escape a value for safe inclusion in a double-quoted XML-ish attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the `<turn …>` prefix for a user message. The returned string ends with a
 * newline so the user's text follows on its own line:
 *
 *   <turn author_id="…" author_name="…" functional_role="developer">
 *   <the user's message>
 */
export function buildTurnTag(identity: TurnIdentity): string {
  const id = escapeAttr(identity.authorId);
  const name = escapeAttr(identity.authorName || "unknown");
  const role = escapeAttr(identity.functionalRole || "developer");
  return `<turn author_id="${id}" author_name="${name}" functional_role="${role}">`;
}

/** Prepend the attribution tag to a user message (tag on its own line). */
export function tagUserMessage(text: string, identity: TurnIdentity): string {
  return `${buildTurnTag(identity)}\n${text}`;
}

/**
 * Derive a human display name from the authenticated user. Prefers the OAuth
 * (Discord) display name in user_metadata, then the email local-part, then the
 * raw id. Never throws.
 */
export function deriveAuthorName(
  userMetadata: Record<string, unknown> | undefined,
  email: string,
  authorId: string,
): string {
  const meta = userMetadata ?? {};
  const candidate =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    (typeof meta.user_name === "string" && meta.user_name) ||
    (typeof meta.preferred_username === "string" && meta.preferred_username) ||
    "";
  if (candidate) return candidate;
  if (email.includes("@")) return email.split("@")[0];
  return email || authorId;
}

/**
 * Working-memory participants template for the shared thread (scope:'thread').
 * Tells the model the thread is multi-user and how to read the <turn> tags, and
 * gives it a slot to track who is in the conversation. Markdown template — Mastra
 * stores it in the thread's metadata and folds it into the system message.
 */
export const TEAM_PARTICIPANTS_TEMPLATE = `# Shared Team Conversation

This thread is SHARED by multiple members of one workspace + FiveM server. Every
user message begins with a \`<turn author_id author_name functional_role>\` tag
that identifies WHO sent it (resolved server-side from their authenticated
identity — it is trustworthy). Read it to attribute requests to the right
teammate and to address people by name.

## Participants
<!-- One line per member seen in this thread: name (functional_role) — note -->

## Shared context
<!-- Decisions, conventions, or constraints the whole team agreed on -->
`;
