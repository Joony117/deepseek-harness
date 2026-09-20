# This checkout is a FORK — read before any git command

This is not a normal clone of deepseek-harness. It carries local work that does
not exist upstream, and `origin` is the **real upstream repository**.

| Fact | Value |
|---|---|
| Working branch | `codex/harness-0.1.2-rc.1` — all local work lives here |
| Fork base | tag `dsh-v0.1.2-rc.1` (`a66e4702047846cdaa10c66c9d3df3951f5ea70d`) |
| Previous base | tag `dsh-v0.1.1-rc.2` (`b150a551b8`), branch `delete-session` — 1,735 commits behind this one |
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
   mirror so rebases have a truthful base. Work goes on `codex/harness-0.1.2-rc.1`.
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
**Two are rc.1's. The middle one is entirely ours** - `deleteStored` does not exist
at the tag (`git show dsh-v0.1.2-rc.1:packages/session/session-persistence-jsonl/src/index.ts`
contains no `deleteStored`), and neither does `supportsDeletion` on the coordinator's
backend interface. An earlier revision of this file called all three "rc.1 mechanisms",
which quietly placed our own guard beyond a fork reviewer's scope. It is ours, and ours
to keep correct:

- **The coordinator owns admission, not the backend.** `session-persistence`'s
  coordinator serializes per-id work and fences publication across a delete.
  A delete requested during an in-flight append is *queued behind it*, not
  refused — the rc.2 backend refused with "persistence work is pending", and
  that refusal is gone on purpose.
- **`deleteStored` verifies the stored header before it removes anything.**
  `findLog` matches on the encoded id in the directory name and never opens the
  file, so without that check a corrupted artifact whose header names a
  different session would be `rm -rf`'d under the requested id. Every other
  refusal in this backend is retryable; a recursive rm is not. Two traps cost a
  data-loss defect each, so do not simplify this guard:
  - **"Unparseable" is not "anonymous".** `parseHeaderMeta` rejects a whole
    header line for a field that carries no identity at all (a negative
    `delegationDepth`, an unknown `origin`), so a header that plainly reads
    `"id":"other"` can still fail to parse. It can also THROW rather than answer
    undefined - a foreign format version, a retired policy field - and that
    rejection has to be allowed to propagate.
  - **"No first line" is not "no bytes".** `readFirstLine` answers `undefined`
    at EOF-before-newline, and `readFirstZstdLine` answers `undefined` when no
    COMPLETE first frame is available - the same answer each gives for an empty
    file. Emptiness must be decided by `stat`, or a header naming another
    session that merely lost its newline to a crash reads as anonymous.
  - **A link is not a directory.** `findLog` opens THROUGH `<project>/<encoded id>`
    without an `lstat`, and `stat` follows links, so a junction standing where that
    session directory should be passes every identity check above - the log behind it
    really does belong to this id. Measured on this box (Node 24.11.1), `fs.rm` with
    `recursive: true` unlinks such a junction WITHOUT descending into it and without
    throwing. So the hazard is not the target's contents; it is the false report. The
    link disappears, `exists` answers false, and the Host publishes a durable removal
    for a log still sitting on disk. `deleteStored` now `lstat`s the directory and
    refuses. Found by the Codex Sol/high review, which reasoned it as a
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

```sh
git fetch origin --tags
git rebase --onto <new-tag> dsh-v0.1.2-rc.1 codex/harness-0.1.2-rc.1
corepack pnpm install --frozen-lockfile
corepack pnpm run gen-cordis-catalog && corepack pnpm run verify-cordis-catalog
corepack pnpm run gen-doc-graphs && corepack pnpm run gen-config-catalog
corepack pnpm run typecheck
corepack pnpm run build
corepack pnpm exec vitest run packages/api/session-controller/tests packages/session/session-persistence/tests packages/session/session-persistence-jsonl/tests packages/session/session-projection-cache/tests packages/client/ui-workspace/tests packages/compaction/compaction-basic/tests
```

Use explicit `.../tests` paths: a bare `packages/session/session-persistence`
filter substring-matches every sibling package whose name starts with it.

The generated docs drift on **every** rebase even when no source changes, because
`docs/config-catalog.md` and `docs/event-producer-consumer.md` carry `file:line`
Source links. Regenerate them, then bring the `.zh.md` side along and re-record
the pair — the table rows there are untranslated generated data, so copying the
changed rows across is correct:

```sh
npx tsx scripts/verify-translation-pairing.ts --write docs/<name>.md
```

Regenerate `packages/extensions/tool-cordis/src/api-catalog.ts` rather than
hand-merging it.

## Known environmental failures on this machine — not regressions

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
