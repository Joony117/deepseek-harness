# This checkout is a FORK — read before any git command

This is not a normal clone of deepseek-harness. It carries local work that does
not exist upstream, and `origin` is the **real upstream repository**. History of
earlier moves (rc.1 cutover, rc.3 rebase, review rounds) lives in the tracker
(Beads lq-0ha, lq-a5y, lq-1bvo) and in W's `change_log.md`, not here.

| Fact | Value |
|---|---|
| Working branch | `codex/harness` — all local work lives here |
| Fork base | tag `dsh-v0.2.2-rc.5` (`9c2670d3bce5275e0d1610272958121af87787bb`) |
| Previous base | tag `dsh-v0.2.0-rc.2` (`639ed015397290b3745d163aafe02ffee4aa3f84`), branch `codex/harness-0.2.0-rc.2` (`ec401d9ab0`: `0cf41bd1cf` plus this rule change) |
| Rollback | branch `codex/harness-0.2.0-rc.2` + the pre-swap `~/.dsh` robocopy backup taken at the rc.5 swap (step 6.2) |
| Upstream default branch | `master` (**not** `main`) |
| `origin` | `https://github.com/deepseek-ai/deepseek-harness.git` — upstream; push URL locally set to `DISABLED-push-to-upstream-forbidden` |
| `fork` | `https://github.com/Joony117/deepseek-harness.git` — the owner's personal fork; the only push target |
| Consumed by | `E:\Qwen3.8_27b\run-dsh-fork.ps1`, which runs `apps/cli/lib/bin.js` |
| Read by | `E:\Qwen3.8_27b\plugins\learning-supervisor.mjs` parses the Working branch row above; keep it the only row of that name |
| Tracker | `E:\local-qwen-tracker` (shared with W; never create another) |

## Rules

1. **Agents may commit, move branches and push to `fork`.** The owner (2026-11-20, verbatim):
   "delete that fork rule, as long as you commit/push to my fork in my GH you can do what ever,
   just dont push to the main DSH devs github". Steps 5 and 6 of the move below still need an
   owner go: they change the live `~/.dsh`, not git.
2. **Push to `fork` only.** `origin` is upstream and its push URL is disabled locally;
   never undo that. Never open an upstream PR unless the owner asks for it.
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

## What the fork carries (over `dsh-v0.2.2-rc.5`)

| Commit | What |
|---|---|
| (a) session delete | `delete` on the persistence seam (JSONL backend), the session-controller `@Remote('delete')`, client `ISessions.delete`, liveshare classifies `session/delete` as `owner-only`, specs |
| (a2) delete UI | one `ctx.contextMenus` session action in `session-actions/context-menus.tsx` (id `delete`, order 475, between upstream's `id` at 450 and `archive` at 600, `danger`, shown only when `session/delete` is allowed) + a `shell.overlay` confirm dialog; drop this commit alone to ship delete as API only. Redone at 0.2.2-rc.5: upstream moved session rows from the `sidebar.workspaces.session.menu.item` slot to structured menu actions |
| (a3, a4) delete fixtures | rc.2 test fakes gain `delete`; upstream menu tests count the delete row |
| (b) compaction | a failed automatic compaction is recorded; the summarizer runs with thinking off. (b2) keeps upstream's rule: a pressure config error is warned, not recorded |
| (c) CallId alias | `packages/llm/llm/src/brand.ts`; listed in `scripts/plugin-entry-existing-exports.ts` (0.2.2's `verify-plugin-entry-exports` gate) as an external-plugin export |
| (d) strict startup | `DSH_STRICT_STARTUP=1` makes every inactive Loader entry fatal in `auditStartupEntries` (rc.2 fails only for its required ids) |
| (d2) strict preflight | under the same switch a compatibility-preflight denial throws instead of disabling the row; an `allow-version` exemption still admits it |
| (h) retired plugin source | `ToolRunContext.deferContext` (the closure in `packages/core/tools/src/pipeline.ts`; redone there at 0.2.2-rc.5) rewrites a 0.1.x `{ kind: 'plugin', plugin }` source to `{ kind: 'plugin:<name>' }`, other fields kept, as the v3→v4 migration names an unknown producer (v4 persistence refuses `plugin`; dsh-plugin-subscriptions' image_generate) |
| (i) icon alias | ui-primitives exports `IconSparkle16 = IconSparkleRegular` for dsh-plugin-subscriptions' client half (else boot-client "did not activate"); the upstream icon-set test skips the alias |
| (j) child limits | spawn/fork Config `maxSteps`, `deadlineMs`, `stallMs` (provider `messageLimits`). Per parent message: they restart when a turn claims a host prompt or a message from the direct parent (`ancestors.at(-1)`); a `send_message` relay from a sibling or the child's own child does not restart them. Time counts only while the child runs (status sampled when the limits attach). A hit disposes the Activation and every resident descendant it created (siblings keep running; pending startups under it are aborted) with `stopReason: 'error'` + diagnostic, which counts queued parent messages discarded unread; a caller stop (dispose, interrupt, archive) stays `aborted`, and no limit fires while it unwinds. `stallMs` counts time inside a tool call (e.g. a workflow tool waiting on grandchildren); only idle time is exempt. Re-read by provider name at cold resume; a resumed child whose provider is gone runs unbounded. Redone at 0.2.2-rc.5 on upstream's rewritten `SubagentManager`: `SubagentHost.messageLimits(provider)`, `enforceMessageLimits` after the Activation's session listener, `budget.admitted` before delivery. Replaces the rc.2 in-process driver budgets (upstream removed that driver when it unified activation lifecycles). `limitSubagentDiagnostic` is exported from `out-of-process.ts` for `activation.ts`, so it is listed in the entry-exports allowlist; the providers pass their whole Config as `messageLimits` and the manager reads only the three fields (none set: no budget). Known gaps (Sol, 2026-11-20): a cold restore starts a fresh budget, so any live tree member's delivery can revive a limit-stopped child (upstream's cold peer delivery; one model step can send several); an interrupt that lands while a step starts (tool resolution, prompt assembly), before the budget sees the turn signal, is reported as a limit if a timer expires in that window; a structured value committed first hides a limit diagnostic; an empty step proposal counts against `maxSteps`. Known gaps (Astra sweep, 2026-11-20, Bead lq-438r): a limit stop can miss a descendant whose cold restore is already in flight; the budget keeps the ids of failed deliveries until the child stops |
| (k) runtime fixes | compaction: the conversation's reasoning effort stays on its own route; default headroom scales and non-converging pressure backs off (a model-switch check neither reads nor writes the backoff); `appendOnly` routes keep prompts append-only (`promptCache: 'append-only'`); a summary answered with only tool calls is re-asked once; fresh tool results are kept until consumed. llm-pi-ai: `preserveThinking` switch; session titles honor their reasoning purpose. context: fresh sessions lead with stable context. subagent/goal: a child's model error reaches the parent as its diagnostic; goal waits for jobs. agent-loop: stop checks follow the step's own ending, not the sticky `max-tokens` turn outcome (lq-wuvb) |
| (e) this file | |

Dropped at 0.2.2-rc.5: `perf(fs-search)` (sibling grep/glob in parallel); upstream 270e7c5a56 sets `isConcurrencySafe: () => true` on both tools.

Generated catalogs, docs graphs and `*.i18n.yaml` records are not carried as hand edits:
they are regenerated after a rebase (recipe step 3).

## Delete invariants (all ours; upstream has no delete)

1. Admission is the backend's single-writer claim (`claimWrite`), held for the whole removal. A held claim refuses (`live`); it never queues.
2. An open read handle or a migration decode refuses as `loading`.
3. **Dual waiting.** The controller raises the deletion fence, then awaits every resume AND every create registered for the id, both when both are pending (`Promise.allSettled`).
4. A `running` Agent is refused, never waited for. An idle owned Agent is disposed first; its `close()` releases the claim.
5. **Header proof.** Every canonical generation's header is proven for the requested id before anything is removed. Header throws propagate.
6. **Size proof.** An `undefined` header on a non-empty file refuses (`unidentifiableHeader`). Emptiness comes from `lstat` size, not the reader.
7. **Link refusals.** The session directory must not be a link (`linkShapedDirectory`); each generation must be a regular file (`irregularGeneration`).
8. **Highest generation last.** Removal runs lowest version first, highest last: a partial failure never rolls back to pre-migration history.
9. **Delete-only `ownsRemoval`.** Only a claimed delete publishes `api-session/removed` itself, after durable absence; every other disposal publishes as upstream.
10. The client removes nothing locally: a refused delete keeps its row and shows the reason.

Known gaps (Sol, 2026-11-20, both from rc.2): (2) the `openHandles` check runs once, so a read handle opened while the delete awaits its lease is not rechecked; (7) a session directory that is a junction to an empty directory returns "absent" before `lstat(dir)`, so the junction stays (nothing is removed through it). On Windows the directory-link test uses a junction and runs without privilege; the file-symlink fixture needs symlink privilege. More delete-path findings from the Astra sweep (2026-11-20) are deferred on Bead lq-438r.

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
corepack pnpm run gen-persistence-catalog && corepack pnpm run gen-cordis-inspect-catalog
corepack pnpm run gen-client-catalog && corepack pnpm run gen-cordis-api
npx tsx scripts/verify-translation-pairing.ts --list    # then --write <pairs> for the pairs the fork changed
corepack pnpm run typecheck && corepack pnpm run build
```

Run `hygiene` by gate label (doc budgets and persistence changes included), then the full
`test` in both trees with `--reporter=json`. Compare failures **by identity** (file + test
name) and signature, never by count. A failure only the fork has blocks until it is
explained (same signature in pristine, or a named cause) or bounded (measured runs, rate,
duration). A crashed worker hides tests as `pending`: rerun their file alone.
Any unhandled error in the fork's run blocks the same way, even with no failing identity:
vitest's `Errors  N error` summary line, `Worker exited unexpectedly`, `EAGAIN`, or
`Some tests are still running when generating the JSON report`.

**4. W checks against the new tree.**
- W's imports of F still resolve: W's plugins import F's built `lib/` by relative path, so
  after the swap they bind to whatever the new tree built. Must end `ALL PRESENT`:
  `node E:/Qwen3.8_27b/tools/fork-upgrade/w-imports-check.mjs $S/harness <W root>`
- Config load exits 0 and its stderr has no `did not activate` or `disabling profile plugin`
  line and no `patch: entry` line, except the exact `patch: entry "<id>" not found` line for a
  disable-only row (a patch whose keys are exactly `id` + `disabled: true`).
  `node E:/Qwen3.8_27b/tools/fork-upgrade/config-gate.mjs` enforces this:
  `LOCAL_QWEN_API_KEY=local node $S/harness/apps/cli/lib/bin.js --profile web --patch E:/Qwen3.8_27b/deepseek-harness.yml --dump-config`
- `--dump-config` runs neither the startup audit nor the preflight, so it proves composition
  only. The strict check is the boot:
- Keyless boot `--port 0` with `DSH_STRICT_STARTUP=1` in a scratch `DSH_HOME`/`HOME`/`USERPROFILE`:
  no warning lines, the engine worker loads, and the expected W and subscriptions entries are
  active (strict mode cannot see an entry that is missing from the tree). Any W path that is
  absolute (memteach stores, supervisor `harnessRoot`) points at staging copies too.
- Every W plugin that writes session messages uses its own source kind (never `plugin`;
  v4 persistence refuses it and the session log stops draining).
- Every `file://` or packaged W plugin's `@deepseek-ai/dsh*` peer range admits the new version.

**5. Dry run on a copy of `~/.dsh`** (owner go; never open credentials). Snapshot order as
in step 6: check campaigns, stop the harness and confirm it exited, then back up (step 6.2).
- **Migration acceptance (counts only):** open every listed session in the copy for write
  with the new tree and print `directories`, `listed`, `migrated`, `alreadyCurrent` and
  `refused` by error class, never ids, paths or content. Pass is `listed == directories`
  and zero refusals. Anything else goes to the owner for a disposition before the swap.
  Resuming a few sessions is not a substitute: it cannot see a session left out of `list`.
- **Rollback rehearsal:** restore the backup into an EMPTY scratch home and open it with the
  previous tree, built after `corepack pnpm install --offline --frozen-lockfile`.

**6. Swap** (owner go), in this order:
1. Step 0 preconditions again (campaigns, 3080 PID owner).
2. Stop the harness and confirm the process exited. Only then back up `~/.dsh` to `$S/backups/` with
   `robocopy <home> <backup> /E /SJ /SL /COPY:DAT /DCOPY:DAT` (links stay links). Not `tar`: Windows
   `tar` follows the profile junctions into F and fails on dangling ones (lq-1bvo P5 rehearsal).
3. In W, make `.prev` copies of every file the swap replaces, and copy `E:/memteach-pkg`
   aside, before any candidate is promoted.
4. Keep the old head as `codex/harness-<old-version>`; move `codex/harness` to the staged
   head in a clean live F (no untracked files either); move aside (never delete) every dir under
   `packages/*/*` and `vendor/*` with no tracked files at the new head (the other version's ignored `lib/` and
   `node_modules` break tsdown's `packages/*/*` glob); install; then build in this order:
   `tsc -b tsconfig.host.json --force`, `pnpm run build:native-system`, `pnpm run build:lib:host`,
   `tsc -b tsconfig.client.json --force`, `pnpm run build`. The `--force` runs clear stale tsc -b state
   after a version switch; the client check needs the `.d.ts` files host tsdown writes (e.g.
   `@deepseek-ai/dsh-office-to-pdf/remote`), so it fails if run before `build:lib:host` (lq-1bvo P5 live swap).
   W's `tools/fork-upgrade/p6-swap.ps1` runs steps 1-5 and the rollback (`-WhatIf` first); `-Resume`
   continues a stopped run at its failed step. Its config gate and keyless boot load both of the launcher's
   patches (`deepseek-harness.yml`, then `dsh-section4.patch.yml`), and its rollback restores F to the head it
   recorded before the switch, whatever `done.txt` says.
5. Apply the W candidates; retire any other launcher that shares `~/.dsh` on another build
   (at rc.2: `E:\Qwen3.8_27b\run-dsh.ps1`).
6. Restart with `E:\Qwen3.8_27b\run-dsh-fork.ps1`; confirm `harness-branch` is green.
7. **Live UI delete check (every rebase):** delete a throwaway session from the row menu;
   the row disappears and its session directory is gone. A refused delete keeps the row.
   Known gap (rc.2): a child subagent session (header `origin: subagent`, `parentSession` = the
   deleted id) keeps its own directory; delete does not cascade.
8. Update the Fork base, Previous base and Rollback rows; push both heads to `fork`.

**Rollback.** Stop the harness. Move the new-era `~/.dsh` aside (keep it; never restore the
backup over it: newer generations would survive and the old tree would pick the highest and
refuse it). Restore the backup into a clean home (same robocopy flags), move `codex/harness` back, move leftovers aside, offline install,
build in the step 4 order, restore W's `.prev` files. Turns written after the swap are lost. Rollback does not
undo Windows ACL grants made on workspaces by the sandbox; account for them separately.

## Known failures at the base (not regressions)

**0.2.2-rc.5 baseline**, measured 2026-11-20 (lq-ki7n): pristine `dsh-v0.2.2-rc.5` (9c2670d3bc), three
full runs of `npx vitest run --reporter=json` after `build:native-system`, Windows 10 19045, Ryzen 7 7800X3D
(16 threads), 63 GB, Node v24.11.1, no symlink privilege. Runs: 207 / 203 / 207 failed tests, 54582 total,
142 failed files each, no unhandled errors. [`FORK-baseline.txt`](FORK-baseline.txt) lists every failing
identity with the runs it failed in: 189 stable (3/3), 38 flaky. Most stable failures are symlink `EPERM`
and git or Windows-process tests. The rc.2 list is in git history (`fork(e3)`).

Identity is the repo-relative file + ` > ` + full test name. A fork run passes when every
failure is listed there. A **stable** failure that passes is fine; a failure not listed
blocks, and every fork-added test must be present and passed. Hygiene at the base fails
`vendor rescope` (3 residue files), `node-next types` ("NodeNext consumer typecheck failed", no detail) and
`Cordis config` (`apps/cli/tests/profiles/acp/cordis.yml` root is not a Loader entry array); the fork may fail
only those three.
A test run leaves an untracked `undefined/temp/` (an upstream test starts tsx without `TEMP`);
remove it, and never run the tests in live F (it would turn `harness-branch` cleanliness red).

A flaky identity that fails in a fork run gets a solo rerun in both trees before it is waved through.
A failure not listed is a **load flake** only when it fails in one of two full fork runs and passes in the
other, and either its package has no fork change or its solo rerun passes 3/3 in the fork; it is then added
to `FORK-baseline.txt` under its fork-run tag (`[f1]`, `[f2]`). A fork-added test may be skipped only by its
own `EPERM` guard on a box without symlink privilege.

The replay snapshot suite (`pnpm run test:snapshot`, keyless replay, writes nothing) fails 202 of 261 at the
base on this box: 142 headless replays fail the ordered-record check (`snapshots/session/headless.snapshot.ts`
~1631) because Windows temp paths are not normalized to `{{cwd}}`. It is not a gate here. Its one fork-added
scenario, `compaction-pending-tool-result`, must fail no worse than the base ones; its expected output is
from rc.2 (0.2.2 wraps runtime context in `<system-reminder>`, adds `subagent:identity` and re-sends the
context after a compaction), so refresh it on a box where the suite passes (Bead lq-438r).
