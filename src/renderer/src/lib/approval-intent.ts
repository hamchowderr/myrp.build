/**
 * Conversational approval intent classifier.
 *
 * When a gated tool (execute_command / delete / deploy_resource) pauses for
 * approval, the user can either click Approve/Decline or simply type a reply.
 * This maps a natural-language reply to an approve/decline decision so the
 * renderer can resolve the pending approval via the existing chat.approve IPC.
 *
 * Mastra's `autoResumeSuspendedTools` does NOT work here — requireApproval-gated
 * tools have no `resumeSchema`, proven in tests/mastra/auto-resume.test.ts — so
 * this app-side bridge is the only viable path for conversational resume.
 *
 * Heuristic, not an LLM call: instant, local, free. Decline is checked first so
 * an explicit "no" wins over an incidental affirmative token. Anything we can't
 * confidently read returns "unclear" — the pause is kept and the buttons remain.
 */
export type ApprovalIntent = "approve" | "decline" | "unclear";

const DECLINE =
  /\b(no|nope|nah|don'?t|do ?not|stop|cancel(led)?|decline[d]?|abort|reject(ed)?|deny|denied|negative|skip|not now|hold on|never ?mind|wait)\b/;

const APPROVE =
  /\b(yes|yep|yeah|yup|sure|ok|okay|approve[d]?|confirm(ed)?|proceed|go ahead|go for it|do it|send it|run it|deploy it|ship it|sounds good|looks good|lgtm|affirmative|accept(ed)?)\b/;

/**
 * Classify a user reply made while a tool is awaiting approval.
 * Returns "unclear" when the reply isn't a recognizable yes/no — callers should
 * keep the approval pending rather than guess.
 */
export function classifyApprovalIntent(text: string): ApprovalIntent {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return "unclear";
  if (DECLINE.test(normalized)) return "decline";
  if (APPROVE.test(normalized)) return "approve";
  return "unclear";
}
