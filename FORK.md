# This checkout is a FORK — read before any git command

This is not a normal clone of deepseek-harness. It carries local work that does
not exist upstream, and `origin` is the **real upstream repository**.

| Fact | Value |
|---|---|
| Working branch | `delete-session` — all local work lives here |
| Fork base | tag `dsh-v0.1.1-rc.2` (`b150a551b8`) |
| Rebased HEAD | `f54cc39d51` (eight local commits replayed onto rc.2) |
| Rollback ref (pre-rebase) | `codex/delete-session-rc8-backup-20260821` (`8ff3db4449`) |
| Older rollback | `codex/delete-session-rc7-backup` (`bec6782544`) |
| Upstream default branch | `master` (**not** `main`) |
| `origin` | `https://github.com/deepseek-ai/deepseek-harness.git` — upstream; push URL locally set to `DISABLED-push-to-upstream-forbidden` |
| `fork` | `https://github.com/Joony117/deepseek-harness.git` — the user's personal fork; the only push target |
| Consumed by | `E:\Qwen3.8_27b\run-dsh-fork.ps1`, which runs `apps/cli/lib/bin.js` |

## Rules

1. **Push to `fork` only.** `origin` is upstream and its push URL is disabled
   locally (`git remote set-url --push origin` would be needed to undo — don't).
   Backups go to `fork` (`Joony117/deepseek-harness`, created 2026-08-25,
   tracker lq-3s0); never open an upstream PR without a Bead authorizing it.
2. **Never commit on `master`.** It tracks `origin/master` and must stay a clean
   mirror so rebases have a truthful base. Work goes on `delete-session`.
3. **Never `reset --hard`, `clean -fd`, or `checkout .`** without asking. The
   built output (`apps/cli/lib/`, `packages/*/lib/`) is gitignored but is what
   the launcher actually runs; blowing it away silently breaks the user's
   harness until a full `corepack pnpm run build`.
4. **Do not commit build output or agent scratch.** `.agent-results/` and
   `.serena/` are excluded via `.git/info/exclude` (local, untracked) rather
   than `.gitignore`, so the tracked ignore file stays byte-identical to
   upstream and never conflicts on rebase.

## Why the diff is deliberately small

This fork exists to carry one feature: a session delete button (see
[details.md](details.md), [change_log.md](change_log.md), [tasks.md](tasks.md),
and [finished_tasks.md](finished_tasks.md) in this directory — synced copies of
the canonical set in `E:\Qwen3.8_27b`). Every line that differs
from upstream is rebase cost when a new tag lands, so local changes are additive
and idiomatic to the files they touch. Two examples of that discipline, worth
preserving if you extend this work:

- `SessionPersistence.supportsDeletion` is a **concrete `false`**, not an
  `abstract` member, so the sqlite backend and any third-party backend compile
  unchanged.
- An unused upstream `oxlint-disable` in `packages/host/apiproxy/src/fetch/handler.ts`
  became redundant because of our change. It was **left in place** — deleting an
  upstream line to silence a warning is not worth the conflict.

## Rebasing onto a new upstream tag

```sh
git fetch origin --tags
git rebase --onto <new-tag> dsh-v0.1.1-rc.2 delete-session
corepack pnpm install --frozen-lockfile
corepack pnpm run gen-cordis-catalog
corepack pnpm run verify-cordis-catalog
corepack pnpm run typecheck
corepack pnpm run build
corepack pnpm exec vitest run packages/host/apiproxy/tests packages/session/session-persistence/tests packages/session/session-persistence-jsonl/tests packages/session/session-projection-cache/tests packages/client/ui-workspace/tests
```

Use explicit `.../tests` paths: a bare `packages/session/session-persistence`
filter substring-matches `session-persistence-sqlite`.

Expect conflicts in the api-proxy wire files and
`packages/client/ui-workspace/src/client/rows/Rows.tsx`; the persistence-seam
addition is small and additive and usually applies cleanly. Treat the new tag as
the base: keep upstream documentation and catalog Source links, then append
local session-deletion semantics. Regenerate
`packages/extensions/tool-cordis/src/api-catalog.ts` rather than hand-merging
it. Keep the new lockfile structure; retain the apiproxy JSONL test dependency.

To roll this rebase back without rewriting later work, reset `delete-session`
to `codex/delete-session-rc8-backup-20260821` (`8ff3db4449`) only after asking.
The ignored file archive is
`E:\deepseek-harness\.agent-results\rebase-backup-20260821-rc2` (SHA-256
manifest included). Stash `d84cb424780ce5f4128d868c9c29dfe1925faecc` still
holds the pre-rebase dirty tree; apply, do not pop, if a retry is needed.

**A green test suite is not proof this feature works.** Both defects fixed in
`f57dd99bba` passed every unit test, because the tests compose a mocked cordis
`Context`. After any rebase, start the harness and delete a throwaway session
through the UI before believing it.
