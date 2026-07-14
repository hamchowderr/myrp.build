# Public open-core repo — keep private things out

`hamchowderr/myrp.build` is the **PUBLIC open-core source of truth** (FSL-1.1-Apache-2.0, clean history). Assume everything here is world-readable: source, **commit messages**, PRs, issues, and the beads tracker (it syncs over `refs/dolt/data` whenever a remote is configured). Treat every artifact you create as published.

## Keep OUT of every public artifact — commits, PRs, issues, and `bd` / `bd remember`
- Secrets, credentials, and secrets-adjacent infra (RCON, `server.cfg` values, DB connection strings, cloud provider/project wiring).
- Security or vulnerability detail before public disclosure.
- Billing / payment internals.
- The **competitive moat / anti-clone strategy** and any unreleased monetization or teams roadmap.

Public commits, issues, and bd notes carry **clean engineering only**. The `git` pre-push secret scan is a backstop, not a licence to be careless.

## `bd remember` writes to the PUBLIC tracker here
The beads Quick-Reference says "use `bd remember` for persistent knowledge" — but on THIS repo that persists to a world-readable tracker. So do **not** put moat, strategy, cloud-private specifics, or any sensitive context in `bd remember` (or issue titles/descriptions/close-reasons). That belongs in the **owner's private vault**, which is the private memory store for this project. If you need that context, search the vault — don't restate it in-repo.

## The RAG corpus is public on purpose
Shipping the ox corpus (`supabase/ox_corpus.jsonl.gz`, issue ic8) is intended — ox knowledge is already public, so the corpus is a head-start, not a secret. It is the one knowledge asset that ships; the private edge stays cloud-side. Don't infer from that that *other* internal detail is fair game — this exception is the corpus only.
