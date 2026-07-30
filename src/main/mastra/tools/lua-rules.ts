/**
 * Per-file forbidden-pattern rules for generated ox_overextended Lua.
 *
 * Split out of validator.ts (which was at 477 of the project's 500-line cap) so
 * the rules have ONE home. They are the enforcement half of
 * {@link ../ground-rules.ts}: GROUND_RULES tells the model what ox-correct means,
 * and these reject the output when it doesn't comply. Keeping them in separate
 * files is a drift risk, so every rule here quotes the ground rule it enforces.
 *
 * WHY ENFORCEMENT AND NOT MORE PROMPT (myrp-build-lar): ground-rules.ts:18 already
 * says "NEVER chat:addMessage" in the strongest terms available, it reaches the
 * supervisor on every lane (prompt.ts:54), and the first live generation on the
 * fixed loop emitted chat:addMessage anyway. Telling the model harder is the one
 * approach with live evidence against it. A validator error is deterministic, and
 * — only since the myrp-build-mg6 fix — actually actionable: the agent can now see
 * its own tool results, so the "fix them and call again" repair loop works.
 *
 * ZERO FALSE POSITIVES is the standing contract for this layer. Every rule is
 * scoped tightly enough that a correct ox resource can never trip it; where a
 * naive pattern would over-match, the narrower anchor is used and the reason is
 * recorded at the rule.
 */
import type { ValidationIssue } from "./validator";

/**
 * Scan ONE .lua file for forbidden patterns.
 *
 * @param rel     resource-relative path, used as the issue's `file`
 * @param content the file's source
 */
export function luaRuleIssues(rel: string, content: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (/GetPlayerPed\s*\(\s*-1\s*\)/.test(content)) {
    issues.push({
      severity: "error",
      message: "Use PlayerPedId() instead of GetPlayerPed(-1)",
      file: rel,
    });
  }

  if (/MySQL\.Async|mysql-async|exports\[['"]mysql-async['"]\]/.test(content)) {
    issues.push({
      severity: "error",
      message: "Use oxmysql, not mysql-async",
      file: rel,
    });
  }

  // Vanilla FiveM notifications (myrp-build-lar). GROUND_RULES: "Notifications are
  // lib.notify … NEVER chat:addMessage, NEVER native NotifyAboveMap/
  // SetNotificationTextEntry."
  //
  // Anchored on the EVENT NAME, never on TriggerClientEvent — the correct ox server
  // form is itself `TriggerClientEvent('ox_lib:notify', …)`, so keying on the
  // trigger would reject the very code we want.
  if (/['"]chat:addMessage['"]/.test(content)) {
    issues.push({
      severity: "error",
      message:
        "Use ox notifications, not chat:addMessage — client: lib.notify({ title, description, type }); server: TriggerClientEvent('ox_lib:notify', source, { title, description, type })",
      file: rel,
    });
  }

  // The native notification chain the same ground rule forbids. SetNotificationTextEntry
  // and AddTextEntry are only ever used to build one, so either is conclusive.
  if (
    /\bSetNotificationTextEntry\s*\(|\bNotifyAboveMap\s*\(|\bDrawNotification\s*\(/.test(content)
  ) {
    issues.push({
      severity: "error",
      message:
        "Use ox notifications, not the native notification chain (SetNotificationTextEntry / DrawNotification) — client: lib.notify({ title, description, type }); server: TriggerClientEvent('ox_lib:notify', source, { ... })",
      file: rel,
    });
  }

  // Non-ox schema leak — ox_core's accounts table has no `bank`/`identifier`
  // columns. Scoped to the `accounts` table to keep false positives at zero.
  if (
    /SELECT[\s\S]{0,60}\bbank\b[\s\S]{0,60}FROM\s+`?accounts`?/i.test(content) ||
    /FROM\s+`?accounts`?[\s\S]{0,80}\bidentifier\b/i.test(content) ||
    /`?accounts`?\.`?bank`?\b/i.test(content)
  ) {
    issues.push({
      severity: "error",
      message:
        "Non-ox accounts schema detected (accounts.bank / accounts.identifier). This is ox_overextended: ox_core's accounts table is (owner=charId, balance) — read with \"SELECT balance FROM accounts WHERE owner = ? AND isDefault = 1\", or use exports.ox_core:GetPlayer(src):getAccount('bank').balance.",
      file: rel,
    });
  }

  return issues;
}

/**
 * Does this Lua actually DO something at runtime, as opposed to being pure config?
 *
 * Gates the "declares ox_lib but never calls lib.*" error: a config-only resource
 * (`Config = {}`) legitimately declares the ox_lib dependency — it is REQUIRED of
 * every ox resource, including config-only ones (validator.ts) — and legitimately
 * contains no lib.* call. Without this guard that rule would fire on correct code,
 * breaking this layer's zero-false-positive contract.
 */
export function hasRuntimeEntrypoint(content: string): boolean {
  return /\bRegisterCommand\s*\(|\bRegisterNetEvent\s*\(|\bAddEventHandler\s*\(|\bCreateThread\s*\(|\bTriggerClientEvent\s*\(|\bTriggerServerEvent\s*\(/.test(
    content,
  );
}
