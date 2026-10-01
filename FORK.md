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
| (a2) delete UI | one `sidebar.workspaces.session.menu.item` (id `delete`, order 450; plugin rows start at 500) + a `shell.overlay` confirm dialog; drop this commit alone to ship delete as API only |
| (a3, a4) delete fixtures | rc.2 test fakes gain `delete`; upstream menu tests count the delete row |
| (b) compaction | a failed automatic compaction is recorded; the summarizer runs with thinking off. (b2) keeps upstream's rule: a pressure config error is warned, not recorded |
| (c) CallId alias | `packages/llm/llm/src/brand.ts` |
| (d) strict startup | `DSH_STRICT_STARTUP=1` makes every inactive Loader entry fatal in `auditStartupEntries` (rc.2 fails only for its required ids) |
| (d2) strict preflight | under the same switch a compatibility-preflight denial throws instead of disabling the row; an `allow-version` exemption still admits it |
| (h) retired plugin source | `ToolRunContext.deferContext` rewrites a 0.1.x `{ kind: 'plugin', plugin }` source to `{ kind: plugin }` (v4 persistence refuses `plugin`; dsh-plugin-subscriptions' image_generate) |
| (i) icon alias | ui-primitives exports `IconSparkle16 = IconSparkleRegular` for dsh-plugin-subscriptions' client half (else boot-client "did not activate"); the upstream icon-set test skips the alias |
| (e) this file | |

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
in step 6: check campaigns, stop the harness and confirm it exited, then tar.
- **Migration acceptance (counts only):** open every listed session in the copy for write
  with the new tree and print `directories`, `listed`, `migrated`, `alreadyCurrent` and
  `refused` by error class, never ids, paths or content. Pass is `listed == directories`
  and zero refusals. Anything else goes to the owner for a disposition before the swap.
  Resuming a few sessions is not a substitute: it cannot see a session left out of `list`.
- **Rollback rehearsal:** extract the tar into an EMPTY scratch home and open it with the
  previous tree, built after `corepack pnpm install --offline --frozen-lockfile`.

**6. Swap** (owner go), in this order:
1. Step 0 preconditions again (campaigns, 3080 PID owner).
2. Stop the harness and confirm the process exited. Only then tar `~/.dsh` to `$S/backups/`.
3. In W, make `.prev` copies of every file the swap replaces, and copy `E:/memteach-pkg`
   aside, before any candidate is promoted.
4. Keep the old head as `codex/harness-<old-version>`; move `codex/harness` to the staged
   head in a clean live F; install; build.
5. Apply the W candidates; retire any other launcher that shares `~/.dsh` on another build
   (at rc.2: `E:\Qwen3.8_27b\run-dsh.ps1`).
6. Restart with `E:\Qwen3.8_27b\run-dsh-fork.ps1`; confirm `harness-branch` is green.
7. **Live UI delete check (every rebase):** delete a throwaway session from the row menu;
   the row disappears and its session directory is gone. A refused delete keeps the row.
8. Update the Fork base, Previous base and Rollback rows; push both heads to `fork`.

**Rollback.** Stop the harness. Move the new-era `~/.dsh` aside (keep it; never extract the
tar over it: newer generations would survive and the old tree would pick the highest and
refuse it). Extract the tar into a clean home, move `codex/harness` back, offline install,
build, restore W's `.prev` files. Turns written after the swap are lost. Rollback does not
undo Windows ACL grants made on workspaces by the sandbox; account for them separately.

## Known failures at the base (not regressions)

**rc.2 baseline**, measured 2026-09-30 (lq-1bvo P2): pristine `dsh-v0.2.0-rc.2`
(639ed01539), three full `pnpm run test` runs, `DSH_COVERAGE_TEST_TIMEOUT_MS` unset,
Windows 10 19045, Ryzen 7 7800X3D (16 threads), 63 GB, Node v24.11.1.
Runs: 28 / 22 / 22 failed tests, 37594 total.

Identity is the repo-relative file + ` > ` + full test name. A fork run passes when every
failure is listed here. A **stable** failure that passes is fine; a failure not listed
blocks. Hygiene at the base fails `vendor rescope` (3 residue files) and `Cordis config`
(`apps/cli/tests/profiles/acp/cordis.yml` root is not a Loader entry array).

Stable (3/3), with signature:
- `packages/client/ui-sidebar-documentpreview/tests/document-preview-license-bundle.client.spec.ts > published document preview licenses keeps bundled licenses in the packed lazy chunks` — `tar: Cannot connect to C: resolve failed`
- `packages/deliverables/workspace-changes/tests/plugin.spec.ts`, 3 tests — `STACK_TRACE_ERROR`:
  `… in a repository records inside the turn when the agent stops, and again after turn/end only when tools settled later`;
  `… in a repository serves each listed file’s comparison from the snapshots or the captured copies`;
  `… without a repository drops a disposed session’s recorder and starts afresh on its next turn`
- `packages/fs/fs-sandbox/tests/fs-sandbox.spec.ts`, 2 symlink-out containment tests (`workspace-write containment a symlinked directory inside the workspace pointing OUT is denied …`, `… a NEW file created under a symlinked-out directory is denied …`) — promise resolved instead of rejecting
- `packages/sandbox/sandbox-windows-acl/tests/diagnose-script.spec.ts` — file error, no message
- `packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts > persistent pwsh through a real cordis.yml Loader composition preserves cwd and environment across calls`
- `packages/subprocess/subprocess-local/tests/native-windows.spec.ts > Windows Job native containment preserves missing-target and invalid-executable rejection errors`
- `packages/subprocess/subprocess-local/tests/spawn-runner.spec.ts > runner launch inputs resolves Windows executables with target-cwd and PATH search semantics`
- `packages/util/native-command/tests/file-applications-windows.spec.ts > queries and invokes a registered Windows handler through the system Shell`
- `scripts/build-exe-for-python-sdk.spec.ts`, 2 tests (`… runs pnpm through its JavaScript entrypoint without a command shell`, `… resolves the pnpm package behind a Windows command shim`)
- `scripts/migrate-sessions-to-v4.spec.ts`, 5 tests (`publishes none|zstd successors …`, `preserves none|zstd parent/child history …`, `shows help, rejects unknown arguments …`) — `STACK_TRACE_ERROR`

Flaky (1 or 2 of 3; load-dependent, mostly `STACK_TRACE_ERROR` timeouts):
- `apps/desktop/tests/windows-cli-signals.spec.ts > Windows Electron console signals delivers SIGINT before process exit` (2/3; the third run was a file error; fails 3/3 when run alone)
- `packages/deliverables/workspace-changes/tests/git.spec.ts > snapshots and diffs fails loudly when the addressed repository cannot be written or diffed` (2/3)
- `packages/skill/skill-office/tests/checkers.spec.ts`, both OOXML checker tests (2/3; pass 3/3 alone)
- `packages/deliverables/workspace-changes/tests/plugin.spec.ts > … keeps an interrupted turn’s record when the next turn starts before it settles` (1/3; passes 3/3 alone)
- `apps/desktop/tests/installed-update-package-content.spec.ts`, `packages/boot/plugin-manager/tests/manager.spec.ts > runs a real pnpm dependency script only after approval and retry`,
  `packages/credentials/credentials-local/tests/local.spec.ts > real hot reload …`, `packages/experimental/webworker-packer/tests/image-loadable.spec.ts`,
  `packages/session/session-persistence-jsonl/tests/catalog-migration.spec.ts` (2 zstd tests), `…/multi-edge-publication.spec.ts` (none),
  `packages/session/session-projection-cache/tests/fixtures.spec.ts` (2 archived-version tests), `scripts/benchmark-npm-resolution.spec.ts` (2),
  `scripts/migrate-sessions-to-v4.spec.ts > … accepts positive safe-integer --jobs 01` (each 1/3)

A flaky identity that fails in a fork run gets a solo rerun in both trees before it is waved through.
