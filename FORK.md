# This checkout is a FORK — read before any git command

This is not a normal clone of deepseek-harness. It carries local work that does
not exist upstream, and `origin` is the **real upstream repository**.

| Fact | Value |
|---|---|
| Working branch | `delete-session` — all local work lives here |
| Fork base | tag `dsh-v0.1.0-rc.8` (`141eb6fef8`) |
| Rollback branch | `codex/delete-session-rc7-backup` (`bec6782544`) |
| Upstream default branch | `master` (**not** `main`) |
| `origin` | `https://github.com/deepseek-ai/deepseek-harness.git` — upstream, not a fork of ours |
| Consumed by | `E:\Qwen3.8_27b\run-dsh-fork.ps1`, which runs `apps/cli/lib/bin.js` |

## Rules

1. **Never push.** `origin` is upstream and there is no fork remote. `git push`
   is always wrong here; if the work needs to leave this machine, ask first.
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
git rebase --onto dsh-v0.1.0-rc.9 dsh-v0.1.0-rc.8 delete-session
corepack pnpm install --frozen-lockfile
corepack pnpm run gen-cordis-catalog
corepack pnpm run verify-cordis-catalog
corepack pnpm run typecheck
corepack pnpm run build
corepack pnpm exec vitest run packages/host/apiproxy packages/session/session-persistence-jsonl packages/client/ui-workspace
```

Expect conflicts in the api-proxy wire files and
`packages/client/ui-workspace/src/client/rows/Rows.tsx`; the persistence-seam
addition is small and additive and usually applies cleanly.

**A green test suite is not proof this feature works.** Both defects fixed in
`f57dd99bba` passed every unit test, because the tests compose a mocked cordis
`Context`. After any rebase, start the harness and delete a throwaway session
through the UI before believing it.
