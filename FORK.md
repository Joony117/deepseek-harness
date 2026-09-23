# This checkout is a FORK — read before any git command

This is not a normal clone of deepseek-harness. It carries local work that does
not exist upstream, and `origin` is the **real upstream repository**.

| Fact | Value |
|---|---|
| Working branch | `codex/harness` — all local work lives here |
| Fork base | tag `dsh-v0.1.5-rc.3` (`a4c74a91e06b00fe0b0937bde982170c526cc842`) |
| Previous base | tag `dsh-v0.1.2-rc.1` (`a66e4702047846cdaa10c66c9d3df3951f5ea70d`), branch `codex/harness-0.1.2-rc.1`; before that `dsh-v0.1.1-rc.2` (`b150a551b8`), branch `delete-session` |
| Rollback (whole tree) | `E:\deepseek-harness.rollback-lq-0ha` — the entire pre-cutover directory, renamed aside by `cutover.sh` |
| Rollback (git ref) | `E:\staging-lq-0ha\old-state`, branch `oldbase` (`7cfca19b5f`) — live F's commits **and** its dirty tree, captured before any change |
| Runtime snapshot | `E:\staging-lq-0ha\backups\dsh-runtime-20260910-pre.tar.gz` — `~/.dsh` as it was pre-cutover |
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
   mirror so rebases have a truthful base. Work goes on `codex/harness`.
3. **Never `reset --hard`, `clean -fd`, or `checkout .`** without asking. The
   built output (`apps/cli/lib/`, `packages/*/lib/`) is gitignored but is what
   the launcher actually runs; blowing it away silently breaks the user's
   harness until a full `corepack pnpm run build`.
4. **Do not commit build output or agent scratch.** `.agent-results/` and
   `.serena/` are excluded via `.git/info/exclude` (local, untracked) rather
   than `.gitignore`, so the tracked ignore file stays byte-identical to
   upstream and never conflicts on rebase.
5. **The fork banner in `AGENTS.md` costs one number upstream.** rc.1 ships that
   file at exactly its 1950-word ceiling — upstream sized the budget to its own
   prose with zero headroom — so any banner at all puts the doc over. The banner
   is now 13 words and `scripts/doc-budgets.manifest.json` carries 1963, the new
   exact size, not a round number, so the gate stays as tight as it was.
   `docs/AGENTS.md` states a ladder — relocate, condense, then raise with
   justification — and that is the order this took. Relocation is not available:
   the banner's whole purpose is to sit at the entry point an agent reads first.
   Condensation ran to the end of its rope: the original 44-word banner named
   `origin`, the disabled push URL, the `fork` remote and the branch, and all four
   facts now live one click away in this file, which the banner links. Trimming
   upstream prose to buy the last 13 words would have been the larger diff and the
   worse one — it invents rebase conflicts in text this fork has no quarrel with.

      **This raise is an AUTHORIZED EXCEPTION, not compliance. Do not cite it as precedent.**
   Astra ruled in round 4 that step 3 of the ladder is qualified by the stricter clause in
   `docs/AGENTS.md`: above target, freeze the ceiling until relocation or condensation brings
   the document under target. Setting the ceiling to the exact current count does not satisfy
   that clause, and the old fork’s larger violation is historical debt rather than an
   exception.

   Compliant condensation was attempted and does not reach 1,950 without cutting upstream
   content. Independently counted: 1,950 at pinned rc.1, 1,963 now, 2,439 in the pre-cutover
   tree. Upstream sized its ceiling to its own prose with zero headroom, so **any** fork
   marker in this file needs either upstream words removed or an authorized exception. Even a
   minimal marker folded into the H1 lands near 1,954. Most of the remaining bulk is the
   repository-layout block, where every line carries a distinct path description, so trimming
   it would delete upstream information rather than condense it.

   **The repository owner authorized the exception on 2026-09-10**, choosing it over trimming
   upstream prose or dropping the banner, on Bead lq-0ha. Its scope is exactly one number:
   the root `AGENTS.md` ceiling at 1,963, carrying a 13-word banner. It is not a general
   licence to raise a ceiling whenever a number stops fitting, and it does not extend to any
   other budgeted document.

   **Do not read the raise as the fork getting sloppier.** Measured 2026-09-10 against the
   pre-cutover tree at `E:/deepseek-harness.rollback-lq-0ha`: the old fork at rc.2 failed
   this same gate by **489 words** (2,439 against the same 1,950 ceiling) with the manifest
   untouched, and had been failing it silently. Taking upstream’s `AGENTS.md` fresh at rc.1
   and re-adding only a condensed banner is what closed that. The allowance is for the banner
   and nothing else.

   **This exception authorises exactly one number, 1,963, and nothing beyond it. It does
   not pre-authorise a future increase.** A rebase that changes the file must re-measure
   with `npx tsx scripts/verify-doc-budgets.ts` and then **re-evaluate the applicable
   documentation-budget policy and obtain its own authorisation** before any new ceiling is
   set. An earlier revision of this paragraph told a future rebase to set the ceiling to
   upstream’s own count plus the banner; Astra round 7 ruled that reads as prospective
   permission beyond what the owner actually authorised, and the ruling is correct.
   Upstream-count-plus-banner is the right thing to *measure*, not a ceiling anyone is
   already cleared to *set*. Any other growth is upstream prose that upstream’s own budget
   was sized for, and needs its own reason.

6. **Commit fork work; never carry it as a dirty tree.** Every fork change lands as a
   commit on `codex/harness` before the session that made it ends. The rc.1 fork kept 69
   files uncommitted after the rc.1 cutover, so the rc.3 rebase first had to capture them by hand
   in a staging clone. A dirty tree also defeats `backup/*` branches and the `fork` push.

## What moved at rc.1 — read this before looking for the old files

The rc.2 fork's session-delete feature lived in `packages/host/apiproxy`. That
package **no longer exists**: rc.1 replaced the hand-written wire layer with
Typert `@Remote` codegen and moved the client plumbing into
`packages/api/session-controller`. The delete work was re-landed there, not
ported file-for-file. The map:

| rc.2 (gone) | rc.1 (now) |
|---|---|
| `packages/host/apiproxy/src/api/sessions.ts` + `.schema.ts` + `rpc-map.ts` | `packages/api/session-controller/src/types.ts` — `@Remote` declarations generate the wire |
| `packages/host/apiproxy/src/fetch/{client,handler}.ts` | generated; there is no hand-written route table to edit |
| `packages/client/runtime/src/client/sessions/**` | `packages/api/session-controller/src/client/sessions/**` |
| `packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx` | `packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx` |
| `packages/session/session-persistence-sqlite` | **deleted upstream.** The user chose to accept that removal; the old work survives only in the rollback refs above. |
| `Session.events` (getter) | `snapshotEvents()`, `eventAt()`, `ownEvents()`, `isOwnSeq()`, `seq` |
| `permissionPresets.current(events)` | `permissionPresets.current(session)` — takes a Session now |

Three mechanisms the delete feature leans on, worth knowing before you change it.
**At rc.3 all three are ours.** rc.3 has no deletion on the persistence seam at all:
`git show dsh-v0.1.5-rc.3:packages/session/session-persistence/src/index.ts` has no
`delete` and no `supportsDeletion`, and `session-persistence-jsonl` has no `delete`.
At rc.1 the admission layer was upstream's coordinator; rc.3 removed that coordinator in
favour of a per-backend single-writer claim, so the delete's admission is now ours too.
An earlier revision of this file called two of the three upstream's, which placed our own
guards beyond a fork reviewer's scope. They are ours, and ours to keep correct:

- **Admission is the single-writer claim, and a held claim is a refusal, not a queue.**
  rc.3's `JsonlBackendTracker.claimWrite` gives each id one writer. The JSONL `delete`
  holds that claim for the whole removal, so no `create` or write `open` can
  materialize the id mid-delete, and only a write handle can publish bytes. If the
  claim is already held (a live handle, a create still constructing, another process's
  kernel lease) the delete refuses with `SessionDeleteConflictError` `live`; an open
  read handle or a historical migration decode refuses with `loading`.
  The rc.1 guarantee "a delete during an in-flight append is *queued behind it*"
  no longer holds at this layer. The waiting moved up one layer, to the controller:
  `session-controller/src/commands.ts` `delete` raises the deletion fence, then awaits
  every resume AND every create registered for the id when the fence went up - both,
  when both are pending (`beginDeletion`, `Promise.allSettled`, so a failed activation
  does not end the wait early). `resolve` and `ensureSession` check the fence and
  register their activation in one synchronous prologue, so an activation is either
  registered before the fence and awaited, or refused as busy. Nothing else is awaited:
  a turn on a live Agent is refused as `running`, not waited for. The port at
  `535c39f919` awaited only one (`resumes.get(id) ?? creations.get(id)`); the host spec
  "awaits BOTH a resume and a create admitted before the fence" fails on that form. The
  delete then refuses a `running` Agent and disposes an idle one it owns before it calls
  the backend. Disposal awaits the write handle's
  `close()`, which completes pending durability and releases the claim, so an idle
  session's last append lands before the delete starts. A claim that survives anyway
  reaches the client as `persistence-conflict`.
- **`delete` proves every generation's header before it removes anything.**
  rc.3 keeps immutable generations side by side (`session.jsonl` … `session.v3.jsonl`),
  and `findLog` matches on the encoded id in the directory name without opening the
  files, so without this check a corrupted artifact whose header names a different
  session would be `rm`'d under the requested id. `deletableGenerations` reads each
  canonical generation through `readGenerationHeader` with the requested id, and the
  removal runs lowest version first, highest LAST: a failure part-way leaves either the
  intact current log or no generation at all, never a silent roll-back to pre-migration
  history. Every other refusal in this backend is retryable; a removal is not. Two traps
  cost a data-loss defect each at rc.1 and both still apply, so do not simplify this guard:
  - **"Unparseable" is not "anonymous".** `readGenerationHeader` answers `undefined`
    when the first line does not `JSON.parse`, and it can THROW rather than answer -
    a header naming another id or path, a header version that disagrees with its
    filename, a format this build cannot read (`sessionFormatCatalog.readHeader`), a
    retired policy field (`assertNoRetiredHeaderFields`). Those throws have to be
    allowed to propagate.
  - **"No first line" is not "no bytes".** `readFirstLine` answers `undefined`
    at EOF-before-newline, and `readFirstZstdLine` answers `undefined` when no
    COMPLETE first frame is available - the same answer each gives for an empty
    file. Emptiness is decided by the entry's own `lstat` size (the regular-file check
    below takes it before the header read): an `undefined` header on a non-empty file
    refuses with `unidentifiableHeader`, or a header naming another session that
    merely lost its newline to a crash would read as anonymous.
  - **A link is not a directory.** `findLog` opens THROUGH `<project>/<encoded id>`
    without an `lstat`, and `stat` follows links, so a junction standing where that
    session directory should be passes every identity check above - the log behind it
    really does belong to this id. Measured on this box (Node 24.11.1), `fs.rm` with
    `recursive: true` unlinks such a junction WITHOUT descending into it and without
    throwing. So the hazard is not the target's contents; it is the false report. The
    link disappears, `exists` answers false, and the Host publishes a durable removal
    for a log still sitting on disk. `delete` `lstat`s the directory and refuses with
    `linkShapedDirectory`. Found by the Codex Sol/high review, which reasoned it as a
    descend-and-destroy path; the measurement says the damage is a lie rather than a
    loss, and the refusal is correct either way.

    **This contradicts `docs/defensive-patterns.md` and the doc is the one that is
    wrong.** That rule - untouched upstream text, near the top of the file - says
    Windows `rmSync(link)` throws `ERR_FS_EISDIR` on a junction and that recursive
    deletion "may descend through one into its target". Neither happens on Node
    24.11.1. Tested four ways: `fs.rmSync` and `fs/promises.rm`, each with the
    junction as the removal target and with a junction nested inside a real removal
    target. Every run removed the link, left the target directory and its files
    intact, and threw nothing - including the non-recursive `rm`, which the doc says
    should throw. **Keep that bounded:** it measures one Node build, one Windows build and
    directory junctions, and it refutes the stated mechanism for those cases. It does not
    establish behaviour on every supported runtime, filesystem or link kind, and it cannot
    disprove a "may" claim in general. The rule's conclusion - reserve recursive removal
    for known real directories - stays correct and is what the new guard follows.
    `docs/defensive-patterns.md` now carries a short platform-qualified note beside that
    rule pointing back here. It is upstream text, and an earlier revision of this file
    used that as the reason to leave it alone; that was wrong. It is also this tree's
    ACTIVE documentation, and a maintainer reads the rule rather than this file, so a
    measured-false mechanism had to be corrected where it is read.
  - **A generation must be a regular file.** The directory `lstat` does not cover the
    files inside it: a symlink named `session.v3.jsonl` passes the filename match, and
    `readGenerationHeader` reads THROUGH it, so a link to another root's log for the same
    id passes the header check too. `rm` then unlinks the link, not its target (measured,
    Node 24.11.1), and the delete reports a durable removal for a log still on disk -
    the same false report as the junction above. `deletableGenerations` `lstat`s each canonical generation before
    it reads the header and refuses anything that is not a regular file with
    `irregularGeneration`. `delete.spec.ts` "refuses a generation file that is a link,
    before reading through it" resolves (deletes the link, reports success) with the
    check removed and refuses with it; it skips itself where the process cannot create a
    file symlink. Bound: the check and the removal are separate calls, so an entry
    swapped for a link between them is not caught; the write lease keeps this harness
    out of that window, not another tool.
- **The Host owns row removal for the lifecycles a delete transaction claims, and only
  those.** For a claimed lifecycle `session/disposed` stops publishing
  `api-session/removed` and the delete publishes it itself, once the backend confirms
  durable absence. Every OTHER disposal still publishes removal exactly as upstream does -
  see the `ownsRemoval` guard in `session-controller/src/index.ts`'s `session/disposed`
  handler. So "published only after durable absence is confirmed" is a statement about
  DELETES, not about removal in general; an earlier revision of this file stated it
  unqualified, which claimed more than the code does. The client deletes nothing locally
  and does not refresh on failure, so a refused delete leaves the row listed with its
  error.

### `SessionProjectionCache.cleanup` takes the id set instead of fetching it

rc.1 dropped the persistence inject this method used to rely on, and states the opposite
invariant for the sibling cold read: that service never consults the persistence layer. The
fork keeps `cleanup` and its return shape but changes the signature to

```ts
cleanup(validIds: Iterable<SessionId>, options: { dryRun: boolean; signal?: AbortSignal })
```

so the caller supplies the set. That preserves the old behaviour without reintroducing a
dependency rc.1 deliberately removed, and it puts the listing where the deletion frontend
already holds persistence.

**Know two things before you build on it.**

First, **nothing calls it, and that is a bigger deal here than it looks.** Measured
2026-09-10: every reference to this package outside its own directory is a type-only
registration import, a `package.json` dependency, a `tsconfig` path or a test.

The pre-cutover fork also had no external caller — but it did not need one. Its `cleanup`
took only `options` and ran `await this.ctx.sessionPersistence.list(options.signal)`
**inside itself**, before any delete, so a rejecting listing threw before a single row could
be removed. It was fail-closed by construction, and the guarantee could not be forgotten
because no caller held it.

Moving the listing out is the right shape for rc.1's invariant that this service must not
consult persistence. It is not a neutral refactor. **The fail-closed guarantee now rests
entirely on caller discipline, and there is no caller to hold it.** An earlier revision of
this section called the absence "not a migration casualty"; that was wrong, and the error was
in the comparison rather than the observation. The obligation is carried as an executable
scenario in `packages/session/session-projection-cache/tests/cache.spec.ts` - the composition
is built in test code, with a positive control. It asserts the composition rejects, that
`cleanup` itself is never called, that `table.delete` is never called, and that every file
under the shared storage root is byte-identical before and after, session-log bytes
included. **A test still only pins an obligation; it does not enforce one.** The claim is
bounded to that tested composition and is not a production-caller guarantee. If you write
the frontend, proving its listing-failure path is your job.

Second, **`cleanup` cannot tell a partial listing from a complete one.** It trusts `validIds`
absolutely: an id missing from that set is stale by definition, and in apply mode its cache
row is deleted. A caller whose listing fails halfway must fail closed and not call `cleanup`
at all, because calling it with what the listing managed to read deletes the rows it did not.
There is a test named for exactly this obligation. It never deletes a session LOG — only
cache rows — so the blast radius is a rebuildable read model rather than user data, and that
direction of dependency is the thing that keeps a cache bug from destroying a transcript.

## What a directory-swap cutover silently drops

`cutover.sh` replaces this checkout by renaming directories, which is why rollback needs
no install and no network. The cost is that **untracked, git-local state does not come
along**, because the staged tree was a fresh clone. Four things were broken by the
2026-09-10 cutover and are worth checking after any future swap:

| Path | What it is | Status |
|---|---|---|
| `.git/info/exclude` | the local ignore rules rule 4 above depends on | **restored** from the pre-cutover tree |
| `.beads/redirect` | points `bd` at `E:\local-qwen-tracker\.beads` | **restored** — without it `bd` run from here cannot find the shared tracker, and the deployment rules forbid creating a second one inside a source checkout |
| `.gitnexus/` | 714 MB generated code index | **not restored** — regenerable, and stale for a 1,735-commit move anyway |
| `E:/staging-lq-0ha/old-state` | the committed snapshot of the pre-cutover dirty tree, branch `oldbase` | **repaired** — see below; it was left a broken repo by the swap |

The first three do not affect `rollback.sh`: it renames the original tree back, so that
tree keeps its own local state intact, and `E:/deepseek-harness.rollback-lq-0ha` was
verified self-contained (189 MB of its own objects, no `alternates` file).

**The fourth is different, and it is the one worth remembering: the swap silently broke a
rollback ref that every document here advertises.** `E:/staging-lq-0ha/old-state` was
created as an object-sharing clone — its `.git/objects` held 1 KB and an
`objects/info/alternates` file pointing at
`E:/staging-lq-0ha/deepseek-harness/.git/objects`. `cutover.sh` then RENAMED that staging
tree into place as live `E:/deepseek-harness`, so the alternate pointed at a path that no
longer existed. Every command in `old-state` died with
`error: unable to normalize alternate object path` and `fatal: bad object HEAD` — while
`git rev-parse --is-bare-repository` still answered `false` and `git branch
--show-current` still answered `oldbase`, so the repo looked alive to any shallow check.

Repaired by repointing the alternate at the moved store, `git repack -a -d` to absorb the
borrowed objects (1 KB -> 145 MB), then deleting the `alternates` file so nothing is
borrowed at all. It now stands alone: `fsck` exits 0, `oldbase` resolves to
`7cfca19b5f`, the committed dirty tree reads back, and the working tree is clean.

Two lessons, both cheap: **an object-sharing clone is not a backup of anything you are
about to move**, and **checking that a rollback ref "exists" is not checking that it
works** — this one was listed as present by every earlier check because the directory was
there. The objects themselves were never at risk; live F pins `7cfca19b5f` with two
branches (`local-snapshot`, `replay-provenance`).

## Why the diff is deliberately small

This fork exists to carry a small set of local features (see
[details.md](details.md), [change_log.md](change_log.md), [tasks.md](tasks.md),
and [finished_tasks.md](finished_tasks.md) in this directory — synced copies of
the canonical set in `E:\Qwen3.8_27b`). Every line that differs
from upstream is rebase cost when a new tag lands, so local changes are additive
and idiomatic to the files they touch. Two examples of that discipline, worth
preserving if you extend this work:

- `SessionPersistence.supportsDeletion` is a **concrete `false`**, not an
  `abstract` member, so any third-party backend compiles unchanged.
- The in-memory fixture answers `session/delete` with a typed
  `session/delete-unsupported` refusal rather than falling through to the route
  default, so the browser shows the real sentence instead of a raw transport
  error.

**Small is the default, not the goal.** Ratified 2026-08-29 — see
`E:\Qwen3.8_27b\ARCHITECTURE.md`, rule 3. Rebase cost is a *price*, not a veto. When F is
the component that directly observes or enforces a fact, F is the correct place to own it,
and the W-side plugin layer must not reconstruct that fact merely to keep this diff
small — that trade buys a clean fork with a dishonest architecture. Price the change
first: `git rev-list --count <base-tag>..origin/master -- <path>` on the exact file, after
a fetch. Prefer additive, seam-shaped changes; invasive control-flow rewrites need a
stronger case and real regression coverage, but are not forbidden. Every F edit still
carries F's full BUILT gate, and a boundary change here is implementer-hard **then**
verifier-hard.

## Rebasing onto a new upstream tag

The recipe below is what the lq-a5y move to `dsh-v0.1.5-rc.3` actually did. Live F is
never touched until the swap step; everything before it runs in a staging directory.

**0. Preconditions.**
- All fork work is committed on `codex/harness` (rule 6). If `git status` in live F is
  not clean, stop and commit first; a dirty tree cannot be rebased and has to be
  captured by hand, which is how rc.1 → rc.3 lost an hour.
- The branch name stays `codex/harness` across rebases. `E:\Qwen3.8_27b\plugins\learning-supervisor.mjs`
  reads the Working branch row above live, so a rename is a W change too.
- No learning campaign in flight: check `~/.dsh/storages/dsh_learning.json` (read only).

**1. Staging clone.** An independent clone, no object sharing (see the cutover section
for why an alternates clone is not a backup):

```sh
S=E:/staging-<bead>
git clone --no-local E:/deepseek-harness $S/harness
git -C $S/harness remote set-url --push origin DISABLED-push-to-upstream-forbidden
git -C $S/harness fetch https://github.com/deepseek-ai/deepseek-harness.git --tags
git -C $S/harness branch backup/pre-rebase-<bead> codex/harness
git -C $S/harness worktree add $S/pristine <new-tag>     # the test baseline
```

**2. Rebase, then take upstream for generated files.**

```sh
git -C $S/harness rebase --onto <new-tag> <old-tag> codex/harness
```

On conflicts in generated docs take upstream's side, then regenerate. The `*.i18n.yaml`
pairing records and the `.zh.md` twins are NOT regenerated by the generators (they only
rewrite English): bring the changed rows across to the `.zh.md` side by hand, then
re-record the pair with `verify-translation-pairing --write`. Regenerate
`packages/extensions/tool-cordis/src/api-catalog.ts` rather than hand-merging it.

**3. Gates, in the rebased tree, all must exit 0.**

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run gen-cordis-catalog && corepack pnpm run verify-cordis-catalog
corepack pnpm run gen-doc-graphs && corepack pnpm run gen-config-catalog
npx tsx scripts/verify-translation-pairing.ts
npx tsx scripts/verify-doc-budgets.ts      # rule 5: AGENTS.md must be upstream count + 13, and only 1,963 is authorised
corepack pnpm run typecheck
corepack pnpm run build
corepack pnpm exec vitest run packages/api/session-controller/tests packages/session/session-persistence/tests packages/session/session-persistence-jsonl/tests packages/session/session-projection-cache/tests packages/client/ui-workspace/tests packages/compaction/compaction-basic/tests packages/llm/llm/tests/brand.spec.ts
```

Use explicit `.../tests` paths: a bare `packages/session/session-persistence`
filter substring-matches every sibling package whose name starts with it.

**4. Full test, compared to pristine by identity.** Install and build pristine too, then
run the suite in both trees with the JSON reporter, so failures are diffed by identity and
signature rather than read off a count:

```sh
for t in harness pristine; do
  (cd $S/$t && corepack pnpm run build:native-system && corepack pnpm exec vitest run \
    --reporter=default --reporter=json --outputFile.json=$S/logs/test-$t.json > $S/logs/test-$t.log 2>&1)
done
```

Each of these blocks until it is explained or bounded:
- a failing identity (file + test name) that the pristine run does not have;
- a changed failure signature on an identity that fails in both trees;
- any unhandled error in the fork's run: vitest's `Errors  N error` summary line,
  `Worker exited unexpectedly`, `EAGAIN`, or `Some tests are still running when generating
  the JSON report`. A crashed worker also hides the tests it had not finished; they sit as
  `pending` in the JSON, so rerun their file alone.

"Explained" means shown in pristine with the same signature, or traced to a named cause.
"Bounded" means measured: runs, rate, duration. "Load" without numbers is neither. A test
that fails in only one tree gets three solo reruns AND three full runs per tree before it
is called load-sensitive, because a solo run cannot recreate the full run's load. Record
the new baseline in the section below.

**5. W config load, both trees.** Each must exit 0. Diff the two dumps; every difference
must be one of the fork's own changes.

```sh
LOCAL_QWEN_API_KEY=local node $S/harness/apps/cli/lib/bin.js --profile web --patch E:/Qwen3.8_27b/deepseek-harness.yml --dump-config > $S/logs/dump-harness.yml
LOCAL_QWEN_API_KEY=local node $S/pristine/apps/cli/lib/bin.js --profile web --patch E:/Qwen3.8_27b/deepseek-harness.yml --dump-config > $S/logs/dump-pristine.yml
```

**6. Pre-swap checks.** All keyless: no model turn, no credentials loaded, never port 3080.
6a and 6b touch staging only. 6c and 6d read a backup of `~/.dsh`, which holds session
content and credentials, so they wait for the owner's go, and the owner takes the backup.
The three scripts were written for lq-a5y; `T` is where they live. Re-read a script
before running it: it is code, and it runs with your rights.

```sh
T=E:/staging-lq-a5y/logs    # w-imports-check.mjs, keyless-boot.ps1, migrate-dry-run.mjs
```

- **6a. W's imports resolve in the new tree.** W's plugins import F's built `lib/` by
  relative path (`../../deepseek-harness/packages/...`), so after the swap they bind to
  whatever the new tree built. The script reads every non-test `.mjs` under W's
  `plugins/`, imports each F target from the tree named, and checks every name. It must
  end `ALL PRESENT`.

  ```sh
  node $T/w-imports-check.mjs $S/harness
  ```

- **6b. Keyless boot of the new tree with W's plugins.** The launcher is not usable here:
  it runs learning-rescue and probes 8080. The script boots `bin.js --profile web` with
  W's yml plus an overlay that disables the two keyed entries (`mcp-brave-search`,
  `llm-subscriptions`), in a scratch `DSH_HOME`/`HOME`/`USERPROFILE` (the supervisor
  writes under `os.homedir()`), with `DSH_TELEMETRY_MODE=DISABLED`, on `--port 0`.
  `-MirrorPlugins` matters: without it W's plugins, where they sit, still import LIVE F's
  `lib/`, so the boot would test a mix of trees. The mirror copies W's plugins beside a
  junction named `deepseek-harness` that points at the new tree, plus the four
  `.agent-results/lq-4cq` code files that `plugins/learning/engine-worker.mjs` imports or
  reads (`untrusted-call.mjs`, `untrusted-launcher.mjs`, `untrusted-runner.mjs`,
  `untrusted-launch-helper.cs`); 6a cannot see that import, only the boot does. Pass is a
  fresh learning-supervisor heartbeat whose `runtimeBin` is inside the new tree: the
  supervisor writes it only after the loader has settled the whole entry tree and the
  WebServer listens. `engine: unloaded` and `selfCheck: false` are expected: W's yml does
  not set `secureMutableEngine`. The script then stops the process tree it started, and
  nothing else. Use a new, empty `-ScratchHome` each time.

  ```sh
  pwsh -File $T/keyless-boot.ps1 -Tree $S/harness -ScratchHome $S/boot-home -MirrorPlugins
  ```

  Not exactly the launcher's boot: the two keyed entries are off, the plugins are a
  copy, and telemetry is off. lq-a5y repair 1 ran it: pass, 0 stderr lines
  (`E:/staging-lq-a5y/logs/repair1-keyless-boot.txt`).

- **6c. Back up `~/.dsh`, then prove the rollback** (owner go). Stop the harness on 3080
  first: it keeps writing sessions, and a copy taken mid-write can hold a torn tail. Then
  restore the backup into a scratch home and boot the OLD tree against it. No mirror
  here: W's imports already point at the old tree. `--force-local` stops tar reading
  `E:` as a remote host.

  ```sh
  B=$S/backups/dsh-runtime-$(date +%Y%m%d)-pre.tar.gz
  mkdir -p $S/backups $S/rollback-home
  tar --force-local -czf $B -C "$USERPROFILE" .dsh
  tar --force-local -xzf $B -C $S/rollback-home
  pwsh -File $T/keyless-boot.ps1 -Tree E:/deepseek-harness -ScratchHome $S/rollback-home
  ```

  `$S/rollback-home` holds a copy of the credentials: delete it once the boot passes.

- **6d. Session migration dry run on a copy** (owner go). A write open migrates a stored
  session (it publishes a successor generation), so the script opens every listed session
  in the copy for write with the NEW tree's backend and closes it. It prints counts only:
  `directories`, `listed`, `migrated`, `alreadyCurrent`, `refused` by error class, never
  ids, paths or content. It refuses a root inside a live DSH home. Pass is an empty
  `refused` and `listed` equal to `directories`; anything else is the owner's call before
  the swap, because a session refused here is one the new tree will not open.

  ```sh
  mkdir -p $S/migrate-copy
  tar --force-local -xzf $B -C $S/migrate-copy .dsh/sessions
  node $T/migrate-dry-run.mjs $S/harness $S/migrate-copy/.dsh/sessions
  ```

  Known limits, measured on synthetic roots: a root in the other compression refuses as a
  whole (`fatal`, with a hint); so does a zstd log whose first frame holds more than the
  header line; and a log whose header does not parse is skipped by `list`, so it shows
  only as `directories` minus `listed`. Delete `$S/migrate-copy` afterwards.

**7. Swap into live F** (a separate owner go; restarting the harness kills in-flight campaigns).
- The 6c backup is the swap's backup, and the harness is still stopped from 6c. If it ran
  again since, take a new backup. Session formats move forward on upgrade, and an older
  fork cannot read turns written by a newer one.
- Point live F's `codex/harness` at the rebased commit (fetch from staging, then
  `git checkout -B codex/harness <sha>` in a clean live F), reinstall, and rebuild. Then
  run the checks in the cutover section below.
- Update the rows at the top of this file: Fork base, Previous base, rollback.
- In W: `details.md` / `tasks.md` / `change_log.md` F rows, and any test fixture that
  names the old branch.
- Restart with `E:\Qwen3.8_27b\run-dsh-fork.ps1` and confirm `harness-branch` is green.

## Known environmental failures on this machine — not regressions

**rc.3 baseline (lq-a5y, 2026-09-22, re-measured in repair 1).** Compare by test identity and
failure signature, never by count. Three full `vitest run` passes per tree, fork
(`E:/staging-lq-a5y/harness`) and plain `dsh-v0.1.5-rc.3` (`E:/staging-lq-a5y/rc3-pristine`),
plus solo reruns:

- **Shared, same signature in all six runs, not the fork's:** `build-exe-for-python-sdk` ×2
  (quoted node path, see below), `pdf-license-bundle` (`npm_execpath is required`),
  `native-windows` "preserves missing-target…", `spawn-runner` "resolves Windows
  executables…", `fs-sandbox` ×2 (a create under a symlinked-out directory resolves). The
  last two are NOT a missing privilege: this box can create symlinks, so `fs-sandbox` is
  upstream containment behaviour on Windows. Flagged, not fixed here.
- **`tool-pwsh-persistent` `loader-composition` "preserves cwd and environment across
  calls": MEASURED.** Plain rc.3 fails it every time: 3/3 full, 3/3 solo, all at the 120 s
  bound. The fork's padded-status fix makes it pass: 3/3 solo at 8.6 s. Under the full
  run's load it takes 64.6 s and 67.8 s, and once 120.3 s, a timeout. So the fork's
  failure is a 7-8× load slowdown that crosses the 120 s bound about one full run in
  three.
- **Pristine only, 5,000 ms timeouts, one run in three each:** `benchmark-npm-resolution`,
  `oxlint-contract`. The fork: 0/3.
- **`Worker exited unexpectedly`: UNRESOLVED, bounded, shared.** Fork 1/3 full runs,
  plain rc.3 2/3, each time with vitest's `Errors  1 error` line; the tests it leaves
  `pending` in the JSON are always in a `session-persistence-jsonl` spec. `content-admission.spec.ts` alone crashes the same
  way: fork 4/10, plain rc.3 5/10. No exit code is printed and Windows logs no event.
  The tests a crash cuts off pass when rerun alone (`multi-edge-publication` 3/3 in both
  trees).
- **`write EAGAIN`: UNRESOLVED, bounded.** Seen once, in the first fork full run of the
  port. 0 in the six repair runs.
- `lsp-stdio` "resolves the cancel grace…" timed out once in the port's first run and
  passes 3/3 alone in both trees. 0 in the six repair runs.

Evidence in `E:/staging-lq-a5y/logs/`: `repair1-load-{harness,rc3-pristine}-{1,2,3}.{json,log}`,
`repair1-solo.txt`, `repair1-crash-loop.txt`, `repair1-crash-*.log`; from the port run,
`pristine-test.log`, `harness-test.log`, `pwsh-loader-rerun.txt`, `lsp-rerun.txt`,
`newfail-rerun.txt`.

The rc.1 record below is kept as history.

`corepack pnpm run test` on this box lands at **2 failed / 16,238 passed /
65 skipped** (16,305 total across 990 files), and both failures are environmental. An
earlier candidate revision — run 2 of five successive candidate runs, not the same state as
this one — produced a third failure, a 5,000 ms timeout that did not recur here. It is shown load-sensitive but its cause is NOT established: see "The
5,000 ms timeout, load-sensitive but not yet explained" at the end of this section.

- `scripts/build-exe-for-python-sdk.spec.ts`, two cases. The dry-run printer
  quotes and backslash-escapes any argument containing a space, and this box's
  Node is at `C:\Program Files\nodejs\node.exe`. The tests expect the raw
  unquoted string. Nothing in this fork touches that file.
- `corepack pnpm run hygiene` fails one gate, `verify-cordis-config`, on
  `apps/cli/tests/profiles/acp/cordis.yml`. That path is a **symlink in the git
  index** (mode `120000`) and this machine has `core.symlinks = false` for want
  of `SeCreateSymbolicLinkPrivilege`, so git materialises all 11 indexed
  symlinks as text files holding their target path. The remedy is a Windows
  privilege rather than an edit here. That is a statement about where the fix
  belongs, not a claim that no code could ever tolerate it: a sufficiently
  defensive upstream reader could accept the materialised text. It is outside
  this fork’s scope, which is a narrower and more defensible claim than
  "not fixable in code".

### The 5,000 ms timeout, load-sensitive but not yet explained

A third failure appeared on the second of five successive candidate full-suite runs:
`scripts/oxlint-contract.spec.ts`, the case "prints only the final diagnostics when a
fix retry still fails", timing out at 5,496 ms against its 5,000 ms limit. Those five runs
measured successive candidate revisions, not one frozen tree; the fifth, FINAL5, is the
designated authoritative final-state run and recorded zero timeouts.

**Acceptance criterion 4 for lq-0ha was closed on 2026-09-10 by an explicit owner-approved
acceptance amendment, NOT by a classification of this timeout.** The owner was given four
costed options - amend acceptance, run a matched pinned-rc.1 control, bump the timeout in F,
or stay parked - and chose the amendment. What was accepted: this one named upstream case
timed out once at 5,496 ms in run 2 of five, and whether the migration contributed is
unmeasured and accepted as unmeasured. The amendment is **not precedent**, does not
reinstate any withdrawn argument, and does not waive the other carried limits. Full text:
`.agent-results/lq-0ha-rc1-20260910/logs/oxlint-timeout-classification.md` in W, section
"Acceptance amendment: criterion 4, the unresolved FINAL2 timeout".

**The bounded finding, and the only wording to use** - unchanged by that amendment:

> The current-tree experiment supports sensitivity of the named case to synthetic CPU
> contention. CPU contention is a plausible explanation for FINAL2. The actual FINAL2
> mechanism and any migration contribution remain unresolved.

An earlier revision of this section called it **classified** as environmental contention
and "not an introduced regression". **That is withdrawn.** Astra ruled the categorical
claim unsupported in round 5 and the ruling is correct. Full record, including the raw
per-run artifacts, is in
`.agent-results/lq-0ha-rc1-20260910/logs/oxlint-timeout-classification.md` in W.

What the experiment did show. The named case was run fifteen times alone, on the final tree
as it then stood, at three load levels on a 16-core box. Unloaded: **5/5 passed,
1,799-1,837 ms**. Against 16
spinning processes: **5/5 timed out, 5,069-5,679 ms**. Against 32: **5/5 timed out,
21.8-24.9 s**. No unloaded run exceeded 1,837 ms and no loaded run came in under 5,069 ms.
All ten failures originate in `@vitest/runner`'s `task()`, the timeout path. A sixteenth
loaded run reproduced the recorded failure line verbatim. The recorded red at 5,496 ms
falls inside the 16-process range — **consistent with contention, not diagnostic of it.**

Two structural facts. `git diff` of the spec, `scripts/run-oxlint.ts`,
`.oxlintrc.staged.json`, `vitest.config.ts` and `vitest.shared.ts` against the pinned tag
is **empty** — which supports unchanged code in those five files, and does **not** support
the broader claim that the migration cannot affect suite scheduling. And the case runs a
**four-Node-process chain below the vitest worker** (tsx CLI, tsx loader plus
`run-oxlint.ts`, then oxlint twice) on vitest's default 5,000 ms, while its immediate
neighbour in the same file using the same helper carries an explicit `90_000` timeout.
That asymmetry is upstream's.

An Astra structural trace on 2026-09-10 confirmed the two-pass finding and corrected an
earlier "three-process chain" claim here. `run-oxlint.ts` retries whenever a `--fix`-family
first pass exits non-zero rather than when another pass can make progress; this fixture's
`@stylistic/max-len` violation has no fixer, so the second pass is pure repeat. Astra
widened the empty-diff check to both lint configs, the manifest, lockfile, workspace config,
`.npmrc`, root TS configs, vitest config and shared transform, `scripts/test-invariants.ts`,
coverage helpers, the gate runner and the PowerShell resolver: **exit 0, empty diff**. But
scheduling **did** change — both projects use `pool: 'forks'` with no repository worker cap,
and new migration tests enter the same `thread-safe` pool, so an unchanged worker limit does
not mean unchanged simultaneous work. **That route is real, unmeasured, and does not resolve
criterion 4.** Full text: `.agent-results/lq-0ha-rc1-20260910/logs/astra-linter-trace.txt`
in W.

**What is not established:** no pinned-rc.1 control was run; changed co-running work is
unmeasured and is the live mechanism; spinner load contends for CPU only; and reproducing
a generic timeout symptom does not identify the historical cause.

**Three arguments are withdrawn and must not be reinstated**, including one that reached a
conclusion the evidence later made plausible — a bad argument stays bad regardless:

1. That the migration adds only "five cheap unit tests" and so cannot shift scheduling.
   **Factually wrong.** The rc.1 baseline totals 16,244 and FINAL4 totals 16,305, a
   difference of **61 tests**, and multiple implementations changed besides. Test count
   also does not bound scheduling effects near a timeout threshold.
2. That the timeout is "a wandering environmental failure the untouched baseline exhibits
   too" — a shared symptom inferred into a shared cause; the baseline's timeout was in
   `session-projection-cache/tests/fixtures.spec.ts`.
3. That the file needs ~15 s in isolation while the case is capped at 5 s — a whole-file
   duration set against a per-case limit.

**What would close it:** a matched comparison of pinned rc.1 and the final tree that
exercises the relevant contention mechanism (representative suite concurrency, or a
bounded reproduction of the implicated co-running workload), preserving named-case timings;
or direct diagnostic evidence; or a validated correction; or an explicit owner-approved
acceptance amendment accepting the unresolved risk. Running the isolated case on both trees
under overwhelming spinners would establish shared susceptibility, not exclude
migration-induced suite contention.

The standing repair, if it recurs: give the case a timeout matching its sibling. That is an
upstream change to an upstream file and was outside this Bead's scope.

The rc.2 floor on this machine was 41 failures. **A count is not a classifier.** Two
failures whose names differ from the two above is a regression even though the number
matches, and a third failure that is a new environmental case is not one. Compare the
named specs and their causes; never the total.

**A green test suite is not proof this feature works.** Both defects fixed in
`f57dd99bba` passed every unit test, because the tests compose a mocked cordis
`Context`. After any rebase, start the harness and delete a throwaway session
through the UI before believing it.

That was done for this rebase, on the cutover build, and both halves are recorded
in `E:\Qwen3.8_27b\.agent-results\lq-0ha-rc1-20260910\logs\live-ui-delete-proof.md`:
a refused delete left the row listed, the dialog open and the file untouched; an
accepted delete removed exactly one session directory and exactly one row; and a bulk
delete of three checked sessions issued three sequential `POST /api/session/delete`,
removed exactly those three directories, and left the two unchecked sessions and three
subagent logs in the same project directory untouched.

Two things that cost time there and will cost it again:

- **A blank session IS deletable - through the current-session row menu, and only
  there.** It is durable on disk once created and `session/list` returns it with
  `blank: true`. `sessionVisible` admits a blank row only when it is the CURRENT
  session, so it has no row at any other moment, and the bulk picker never offers one
  because `bulkDeleteCandidates` calls `sessionVisible(session, undefined, archived)` -
  passing `undefined` as `current` excludes every blank session by construction. But the
  current blank row keeps a Delete-only menu deliberately: `Rows.tsx` says delete
  "targets the session identity rather than its content, which a blank row does have",
  and `workspace-browser.client.spec.tsx` pins that whole path, menu through confirm.

  **An earlier revision of this file said no UI path offers a blank session as a delete
  target. That was false.** It generalised from the BULK picker's exclusion to the entire
  UI. The refusal recorded in the live proof - "Session storage is still busy with this
  session" - was itself reached through the very path that sentence denied existed.
  `sessionVisible` is unchanged from the rc.1 tag, so the visibility rule is upstream's;
  the wrong conclusion was ours.

  **The refusal is a retry condition, not a missing affordance, and this is now measured
  rather than argued.** A freshly loaded session's preparation entry is not yet `ready`,
  so `deletionBlocker` answers its phase and the Host refuses with "Session storage is
  still busy with this session. Try again shortly." Clicking the same confirm button again
  about five seconds later deletes it: the row goes, the session directory leaves disk, and
  it stays gone across a page reload and a full harness restart. Full record in
  `live-ui-delete-proof.md` section 5. The message means what it says; the earlier work
  treated it as a permanent property instead of retrying.
- If you cannot spend a model turn (the GPU may belong to another session), mint
  one directly: plug `SessionStore` + `JsonlSessionPersistence` at root
  `C:\Users\Joony\.dsh\sessions`, `create()` a header and `append()` one turn
  ending in a `session/title` event. The Host caches its session enumeration, so
  restart the harness afterwards or the new artifact will not appear. `freezeMessage`
  and `MessageId` come from `@deepseek-ai/dsh-llm`, not from a message package.
