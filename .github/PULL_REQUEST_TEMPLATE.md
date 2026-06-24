<!--
  Read CONTRIBUTING.md §8 before opening this PR.
  HARD RULE: no linked, maintainer-approved issue -> no PR. Unsolicited large PRs and
  any AI-generated PR without a linked issue are auto-closed -- no exceptions, even if CI is green.
-->

## What & why

<!-- What does this change, and WHY? Link the issue/discussion you agreed the approach on. -->

Closes #

## How I verified it

<!-- Show your work: what you ran, what you saw. "Trust me" is not verification. -->

-

## Checklist

- [ ] **Talked first** — this PR is tied to an issue/discussion a maintainer already 👍'd (or it's a trivial one-line fix).
- [ ] **One concern** — this PR does a single focused thing (no bundled refactors, dep bumps, or formatting sweeps).
- [ ] **I understand and stand behind every line** — AI assistance is fine, but I authored, ran, and reviewed this; it is not unverified model output.
- [ ] **Tests** — behavior changes/bug fixes come with AIMock coverage (or I've explained why none applies).
- [ ] **Quality gate is green locally**: `npm run typecheck && npm run check && npm test`.
- [ ] **Conventions** — respects ox-only, the 500-line/file cap, and keeps `src/preload/index.d.ts` ↔ `src/renderer/src/env.d.ts` in sync (see CONTRIBUTING §5).
- [ ] **CLA** — I'll sign it when the bot prompts (one-time).

<!--
  Maintainer discretion is final: a green CI does not guarantee a merge.
  Scope, fit, and product direction are the maintainer's call.
-->
