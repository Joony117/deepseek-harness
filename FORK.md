# This checkout is a FORK — read before any git command

This is not a normal clone of deepseek-harness. It carries local work that does
not exist upstream, and `origin` is the **real upstream repository**. History of
earlier moves (rc.1 cutover, rc.3 rebase, review rounds) lives in the tracker
(Beads lq-0ha, lq-a5y, lq-1bvo) and in W's `change_log.md`, not here.

| Fact | Value |
|---|---|
| Working branch | `codex/harness` — all local work lives here |
| Fork base | tag `dsh-v0.2.0-rc.2` (`639ed015397290b3745d163aafe02ffee4aa3f84`) |
| Previous base | tag `dsh-v0.1.5-rc.3` (`a4c74a91e06b00fe0b0937bde982170c526cc842`), branch `codex/harness-0.1.5-rc.3` (`11b710e70b`) |
| Rollback | branch `codex/harness-0.1.5-rc.3` + the pre-swap `~/.dsh` tar under `E:\staging-lq-1bvo\backups\` |
| Upstream default branch | `master` (**not** `main`) |
| `origin` | `https://github.com/deepseek-ai/deepseek-harness.git` — upstream; push URL locally set to `DISABLED-push-to-upstream-forbidden` |
| `fork` | `https://github.com/Joony117/deepseek-harness.git` — the owner's personal fork; the only push target |
| Consumed by | `E:\Qwen3.8_27b\run-dsh-fork.ps1`, which runs `apps/cli/lib/bin.js` |
| Read by | `E:\Qwen3.8_27b\plugins\learning-supervisor.mjs` parses the Working branch row above; keep it the only row of that name |
| Tracker | `E:\local-qwen-tracker` (shared with W; never create another) |

## Rules

1. **Commits, pushes, branch moves and the swap are owner-only.** An agent works in a
   staging clone and hands over a branch or patches; the owner lands them.
2. **Push to `fork` only.** `origin` is upstream and its push URL is disabled locally;
   never undo that. Never open an upstream PR without a Bead authorising it.
3. **Live F stays clean on the working branch.** `git status` in `E:\deepseek-harness`
   is empty, and `master` stays a clean mirror of `origin/master`.
4. **Never `reset --hard`, `clean -fd` or `checkout .`.** The gitignored build output
   (`apps/cli/lib/`, `packages/*/lib/`) is what the launcher runs.
5. **Local ignores go in `.git/info/exclude`** (`.agent-results/`, `.serena/`), never in
   `.gitignore`, so the tracked ignore file stays byte-identical to upstream.
6. **Upstream comes in only by tag, in a staging clone.** Never merge `master`, never
   rebase in live F.
7. **No fork banner in `AGENTS.md`.** Upstream sizes it to its ceiling; W's `CLAUDE.md`
   already points readers here.

## What the fork carries (over `dsh-v0.2.0-rc.2`)

| Commit | What |
|---|---|
| (a) session delete | `delete` on the persistence seam (JSONL backend), the session-controller `@Remote('delete')`, client `ISessions.delete`, specs |
| (a2) delete UI | one `sidebar.workspaces.session.menu.item` (id `delete`, order 500) + a `shell.overlay` confirm dialog; drop this commit alone to ship delete as API only |
| (b) compaction | a failed automatic compaction is recorded; the summarizer runs with thinking off |
| (c) CallId alias | `packages/llm/llm/src/brand.ts` |
| (d) strict startup | `DSH_STRICT_STARTUP=1` makes every inactive Loader entry fatal in `auditStartupEntries` (rc.2 fails only for its required ids) |
| (e) this file | |

Generated catalogs, docs graphs and `*.i18n.yaml` records are not carried as hand edits:
they are regenerated after a rebase (recipe step 3).

## Delete invariants (all ours; upstream has no delete)

1. Admission is the backend's single-writer claim (`claimWrite`), held for the whole removal. A held claim refuses (`live`); it never queues.
2. An open read handle or a migration decode refuses as `loading`.
3. The controller raises the deletion fence, then awaits every resume AND create registered for the id (`Promise.allSettled`).
4. A `running` Agent is refused, never waited for. An idle owned Agent is disposed first; its `close()` releases the claim.
5. Every canonical generation's header is proven for the requested id before anything is removed. Header throws propagate.
6. An `undefined` header on a non-empty file refuses (`unidentifiableHeader`). Emptiness comes from `lstat` size, not the reader.
7. The session directory must not be a link (`linkShapedDirectory`); each generation must be a regular file (`irregularGeneration`).
8. Removal runs lowest version first, current log last: a partial failure never rolls back to pre-migration history.
9. `ownsRemoval` applies only to a claimed delete: the delete publishes `api-session/removed` after durable absence; every other disposal publishes as upstream.
10. The client removes nothing locally: a refused delete keeps its row and shows the reason.

## Rebasing onto a new upstream tag

Live F is not touched until the swap. `S` is a fresh staging directory named for the Bead.

**0. Preconditions.** Live F clean (rule 3). No learning campaign in `collecting`,
`staged`, `validating`, `ready` or `promoting` in `~/.dsh/storages/dsh_learning.json`
(read only). Check who owns the 3080 PID before any restart.

**1. Staging clone** (no object sharing):

```sh
git clone --no-local E:/deepseek-harness $S/harness
git -C $S/harness remote set-url --push origin DISABLED-push-to-upstream-forbidden
git -C $S/harness fetch https://github.com/deepseek-ai/deepseek-harness.git --tags
git -C $S/harness branch backup/pre-rebase-<bead> codex/harness
git clone --no-local $S/harness $S/pristine && git -C $S/pristine checkout <new-tag>
```

**2. Rebase in one jump**, then take upstream's side for generated files:

```sh
git -C $S/harness rebase --onto <new-tag> <old-tag> codex/harness
```

**3. Install, regenerate, gate** (both trees; every command exits 0):

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run gen-cordis-catalog && corepack pnpm run gen-doc-graphs && corepack pnpm run gen-config-catalog
corepack pnpm run gen-client-catalog && corepack pnpm run gen-cordis-api
npx tsx scripts/verify-translation-pairing.ts --list    # then --write <pairs> for the pairs the fork changed
corepack pnpm run typecheck && corepack pnpm run build
```

Run `hygiene` by gate label (doc budgets and persistence changes included), then the full
`test` in both trees with `--reporter=json`. Compare failures **by identity** (file + test
name) and signature, never by count. A failure only the fork has blocks until it is
explained (same signature in pristine, or a named cause) or bounded (measured runs, rate,
duration). A crashed worker hides tests as `pending`: rerun their file alone.

**4. W checks against the new tree.**
- Config load exits 0 and its stderr has no `did not activate`, `disabling profile plugin`
  or `patch: entry` line:
  `LOCAL_QWEN_API_KEY=local node $S/harness/apps/cli/lib/bin.js --profile web --patch E:/Qwen3.8_27b/deepseek-harness.yml --dump-config`
- Keyless boot `--port 0` with `DSH_STRICT_STARTUP=1` in a scratch `DSH_HOME`/`HOME`/`USERPROFILE`:
  no warning lines, and the engine worker loads.
- Every W plugin that writes session messages uses its own source kind (never `plugin`;
  v4 persistence refuses it and the session log stops draining).
- Every `file://` or packaged W plugin's `@deepseek-ai/dsh*` peer range admits the new version.

**5. Dry run on a copy of `~/.dsh`** (owner go; never open credentials): migration of
every session, resume of a few, rollback rehearsal on the previous branch with
`corepack pnpm install --offline --frozen-lockfile` and a build.

**6. Swap** (owner go). Stop the harness; tar `~/.dsh` to `$S/backups/`; keep the old
head as `codex/harness-<old-version>`; move `codex/harness` to the staged head in a clean
live F; install; build; restart with `E:\Qwen3.8_27b\run-dsh-fork.ps1`; confirm
`harness-branch` is green; update the Fork base, Previous base and Rollback rows; push
both heads to `fork`. Session formats move forward: after the swap the old tree cannot
read new turns, so a rollback restores the tar and loses them.

## Known failures at the base (not regressions)

**rc.2 baseline: not yet measured.** Record here the pristine `dsh-v0.2.0-rc.2` failing
identities and signatures from step 3 (lq-1bvo), three full runs, with the machine,
Node version and date.
