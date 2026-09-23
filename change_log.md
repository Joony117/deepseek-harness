# Change log

Newest first. Technical background for every entry is in [details.md](details.md).

Two repositories are involved:

- **W** = `E:\Qwen3.8_27b` (this workspace, branch `main`)
- **F** = `E:\deepseek-harness` (harness fork, branch `codex/harness-0.1.2-rc.1`, base tag `dsh-v0.1.2-rc.1`)

---

## 2026-09-10 — Harness fork rebased 1,735 commits onto `dsh-v0.1.2-rc.1` (lq-0ha)

### F `codex/harness-0.1.2-rc.1` — the fork's whole feature set re-landed on the new base

The fork sat on `dsh-v0.1.1-rc.2` (`b150a551b8`). Upstream moved 1,735 commits to
`dsh-v0.1.2-rc.1` (`a66e4702047846cdaa10c66c9d3df3951f5ea70d`) and deleted two packages the
fork's work lived in, so this was not a rebase in the `git rebase` sense — three of the
five features had no file left to conflict with.

**What upstream removed or moved.** `packages/host/apiproxy` is gone: rc.1 generates the
wire from Typert `@Remote` declarations, so the hand-written schema, rpc-map and fetch
routes have no successor to edit. `packages/session/session-persistence-sqlite` is gone
too — the user chose to accept that removal rather than carry a dead backend, and the
original SQLite work now survives only in the rollback refs. Client session plumbing moved
from `packages/client/runtime` to `packages/api/session-controller`. `Session.events`
stopped being a getter; `permissionPresets.current()` now takes a `Session` instead of an
event array. `FORK.md` carries the full old→new map.

**Session deletion, re-landed at the correct owner.** The Host owns row removal for the
lifecycles a delete transaction claims, and only those: for a claimed lifecycle
`session/disposed` stops publishing `api-session/removed`, and the delete publishes it
itself once the backend confirms durable absence. Every other disposal still publishes
removal exactly as upstream does.
The client deletes nothing locally and does not refresh on failure, so a refused delete
leaves the row listed with its own error and the dialog open for retry. That fence was
proved load-bearing rather than asserted: injecting optimistic row removal into the UI
turns three `workspace-browser` tests red (a refused session's row vanishes while its
sibling and its error message stay), and removing the injection returns 155/155.

**Two defects the migration introduced, both found by reverting rather than by reading.**
The publication fence in `session-persistence`'s coordinator needed two stamps, not one:
removing `assertNotDeleting` let a session go live over a log being deleted (the test threw
nothing and hung 10,015 ms), and removing the `initFor` generation stamp let a disposed
fresh session silently resurrect under a deleted identity. Both restored, 656 tests green.

**One defect the migration introduced that would have destroyed data.** rc.1's
`deleteStored` resolved the artifact through `findLog`, which matches on the encoded id in
the *directory name* and never opens the file — so its own doc comment's claim to inherit
the read path's refusals was false for the one refusal that matters. Asked to delete
session A, with A's directory holding an artifact whose header says B, it returned success
and `rm -rf`'d B's only log. The rc.2 fork refused and left the file byte-identical. Fixed
by reading the header (the same header-only read listing uses) and running
`assertStoredIdentity` before the removal. Every other refusal in that backend is
retryable; a recursive rm is not.

**One defect the packaging gates caught.** `session-controller/src/commands.ts` imported
`SessionDeleteConflictError` as a *value* from `@deepseek-ai/dsh-session-persistence`,
which the package declares optional in `peerDependenciesMeta`. A static value import is
evaluated at module load, so one install without session-persistence would have turned
"delete is unavailable" into a load failure for every command in the controller. Now
type-only, with a structural guard on the name the class sets in its constructor.
Corrupting that name string takes the suite from 440/440 to 439/440, so the guard is
load-bearing.

**Also carried.** The compaction feature from F `89833cecda` (no-think summarizer, 16K
default cap, surfaced auto-compaction failures), which at rc.1 must additionally satisfy
the new invariant registry — hence
`compaction-basic/tests/automatic-failure-invariant.spec.ts`. The persistent-shell padded
status-line patch, committed as `748b090fef` with the padding coverage the original
lacked. The in-memory fixture's typed `session/delete-unsupported` refusal, so the browser
fixture shows the real sentence instead of a raw transport error. The three backend delete
tests that lived in `jsonl.spec.ts`; the third of them now pins rc.1's *queueing* behaviour
in place of rc.2's "persistence work is pending" refusal, which the coordinator's per-id
serialization replaced.

**A second data-loss defect in the same guard, found by adversarial review after the first
was fixed.** The header-identity check refused to delete when the stored header named
another session — but it decided "this artifact has no header at all, so it names nobody"
from the header reader answering `undefined`. Both readers answer `undefined` for an empty
file *and* for a file whose bytes never complete a first line: raw `readFirstLine` at
EOF-before-newline, and `readFirstZstdLine` when no complete first frame is available. So a
complete header naming session B that merely lost its trailing newline to a crash — or a
header frame torn mid-write — read as anonymous, and B's only log was removed under A's id.
Emptiness is now decided by `stat`, not by the reader: only a zero-byte artifact is
anonymous, and anything with bytes must produce a header that parses and matches. Both
halves have a regression test that fails on the old code by *succeeding* (`jsonl.spec.ts`
"lost its newline", `zstd.spec.ts` "first zstd frame is present but truncated"). Worth
stating plainly: the first fix's own tests covered a genuinely empty file and
complete-but-malformed headers, and passed the whole way through; neither case is the one
that destroys data.

**A third finding in the same guard, where the reviewer's mechanism was wrong and the
conclusion was right.** The same cross-family review flagged the recursive `rm` for
accepting a link-shaped session directory: `findLog` opens *through* `<project>/<encoded
id>` without an `lstat`, and `stat` follows links, so a Windows junction standing there
satisfies every identity check — the log behind it really does belong to the requested id.
The review reasoned this would descend into the junction and destroy its target, citing
`docs/defensive-patterns.md`, and said plainly it had not reproduced it. Measured on this
box (Node 24.11.1, four combinations: `fs.rmSync` and `fs/promises.rm`, junction as the
removal target and junction nested inside one) it does not happen — every run unlinked the
link, left the target directory and its files intact, and threw nothing, including the
non-recursive `rm` the doc says should throw `ERR_FS_EISDIR`. That upstream rule is false on
this Node; it is left uncorrected because it is upstream text this fork does not own, and
the contradiction is recorded in `FORK.md` instead. The finding survives in the opposite
direction: unlinking the junction makes `exists()` answer false, so the coordinator commits,
the generation advances, and the Host publishes `api-session/removed` — a durable-deletion
claim for a log still sitting on disk, under a dialog that says the deletion cannot be
undone. `deleteStored` now `lstat`s the session directory and refuses a link rather than
removing it; the regression test fails on the old code by *resolving* instead of rejecting.
Only that one call needed the guard — the backend's other recursive `rm` targets a directory
`mkdtemp` had just created, which is a known real directory by the same rule.
**Verification.** `typecheck`, `build` and `oxlint` exit 0. `corepack pnpm run test` is
**2 failed / 16,227 passed / 65 skipped** across 990 files, against the rc.2 floor of 41
failures on this machine. Both remaining failures are
`scripts/build-exe-for-python-sdk.spec.ts` expecting an unquoted `process.execPath`, which
this box cannot satisfy because Node lives under `C:\Program Files\`. `doc-sync` is 32/32.
`hygiene` is 14/1, the one failure being `verify-cordis-config` reading a symlink as text
because `core.symlinks = false` on a machine without `SeCreateSymbolicLinkPrivilege`.
Neither is fixable in code.

**Deletion was proved on the running harness, not only in tests.** A refused delete left the
row listed, the dialog open and the artifact byte-identical; an accepted delete removed
exactly one session directory and one row; and a bulk delete of three checked sessions
issued three sequential `POST /api/session/delete` and removed exactly those three, leaving
the two unchecked sessions and three subagent logs in the same project directory untouched.
Full record in
`E:\Qwen3.8_27b\.agent-results\lq-0ha-rc1-20260910\logs\live-ui-delete-proof.md`. No request
reached the model server on port 8080 at any point: the throwaway sessions were minted
directly through `SessionStore` + `JsonlSessionPersistence`.

### W — plugins adapted to the rc.1 session API

`plugins/learning-supervisor.mjs` and `plugins/command-doctor.mjs` (with their tests) move
off the removed `Session.events` getter. The supervisor's telemetry now names a missing
session explicitly — `terminationReason: 'session_unavailable'` — rather than routing it
through the nullish-tolerant helper and reporting `completed`, which would have been a
quieter and worse answer than naming the condition. Editing `learning-supervisor.mjs` is a
root-of-trust change; it was authorized for this compatibility break specifically, and
carries W's BUILT gate.

### Rollback

`cutover.sh` swaps directories rather than checking out in place, so the staged tree brings
its own installed `node_modules` and `rollback.sh` restores the exact original by renaming
back — no install, no network, no pnpm store. The pre-cutover tree is parked at
`E:\deepseek-harness.rollback-lq-0ha`, its git state at `E:\staging-lq-0ha\old-state`
branch `oldbase` (`7cfca19b5f`, commits *and* dirty tree), and `~/.dsh` at
`E:\staging-lq-0ha\backups\dsh-runtime-20260910-pre.tar.gz`.

**Correction, 2026-09-10 — one of those three rollback refs was broken, and every shallow
check said it was fine.** `E:\staging-lq-0ha\old-state` was created as an object-sharing
clone: its `objects/info/alternates` pointed at
`E:\staging-lq-0ha\deepseek-harness\.git\objects`, which is a path the cutover then renamed
away. It kept passing inspection afterwards because the checks being run were the wrong kind
— the directory exists, `rev-parse --is-bare-repository` says false, `branch --show-current`
says `oldbase` — while every command that actually needs an object died with `fatal: bad
object HEAD`. A ref that answers metadata questions correctly and cannot produce a single
byte of content is worse than a missing one, because it reports healthy.

Repaired to standalone: alternates repointed at the live `E:\deepseek-harness\.git\objects`,
`git repack -a -d` to pull the objects in (1 KB to 145 MB, which is the measurement that
proves it had been holding nothing), then the alternates file deleted so nothing external is
referenced. Now `git fsck` exits 0, `oldbase` resolves to `7cfca19b5f`, and the tree is
clean. The primary rollback path, `E:\deepseek-harness.rollback-lq-0ha`, was never affected:
189 MB of its own objects and no alternates file at any point.

The lesson is about the instrument, not the ref. Verify a backup by making it produce
content — `git log -1`, `git fsck` — never by confirming it exists.


---

## 2026-08-19 — A dead refinement worker spends a repair generation (DSH-07)

### W `64cc85e` — Retry a manifest-less worker instead of abandoning the campaign

Campaign `64ff4138` (DSH-04) died at its per-response output cap: 61 steps, 75 read-only
tool calls, ~754k characters of reasoning, and a final step at `outputTokens: 32768` —
exactly the configured `maxTokens` — with `turn/end reason.kind = "max-tokens"`. Context was
never the binding limit (~160k of 200k). `captureStructured` saw no submission, threw, and
the campaign loop abandoned outright on the first worker exception, so `refinementRepairCycles`
never applied to the one failure mode that had actually occurred.

**Decision: option three of the three candidates.** A worker exception now consumes a repair
generation. The other two were considered and rejected:

- *Lower `reasoningEffort` for the refinement child.* `maxTokens: 32768` and
  `reasoningEffort: medium` come from the `local-qwen` provider block, which is
  provider-wide, not per-child. Turning down reasoning for the refinement worker would turn
  it down for the main agent too. No per-child seam exists, and inventing one costs more
  than the retry.
- *Cap exploration with a read budget.* A counted read limit is a new accountant with new
  state, which the ticket's non-goals rule out. The persona already says "make at most the
  necessary bounded reads"; the worker ignored it, and a hard cap would truncate legitimate
  work as readily as runaway work.

The retry is not a bare retry. The failure text becomes the next generation's `findings`
entry — "returned no structured manifest … make far fewer reads, keep reasoning short, and
call learning_stage then learning_submit early" — and `previous` is cleared, since there is
no prior candidate to repair. The same path covers a timeout or a malformed submission; all
three arrive as the same exception and all three deserve a shorter second attempt.

**Fail-closed is preserved by construction.** The `catch` ends in `continue`, so `manifest`
stays `undefined` and `stageManifest` is never reached with a partial run — asserted
directly by a test that makes `stageManifest` throw if it is called at all. The final
generation still abandons, and an aborted `invocation.signal` abandons immediately rather
than burning two retries on a cancelled campaign. Each failure appends its own
`{ name: 'worker', ok: false }` validator row, so `/refine status` shows how many generations
died and why.

Three new tests: the retry-then-succeed path, the fail-closed path (worker called
`refinementRepairCycles + 1` times, nothing staged, `patchManifest` empty), and the cancelled
path. W BUILT green at **55 tests**.

**Docs correction found in passing.** `CLAUDE.md` claimed the glob was 50 tests (35 learning).
It was 52 (37 learning) before this change — DSH-04 and DSH-05 added two learning tests
without updating the count. Corrected to 55/40 along with this entry.

---

## 2026-08-19 — A blank session has no delete affordance; DSH-06 blocked (DSH-06)

### W — no code changed; finding recorded

DSH-06 asked for the leftover blank end-to-end test session to be deleted through the UI
button shipped on 2026-08-18. It could not be: **the row-actions menu that carries Delete is
never rendered for a blank session**, so the button is structurally unreachable for exactly
the class of session the ticket wanted to remove.

Two separate corrections came out of the attempt.

**The ticket named the wrong session.** DSH-06 identified `session-43568c47` as "0 turns, no
title". On disk that session has **3 turns and the title "hello"** — and its turn 3 is the
conversation that specified the whole continual-learning loop ("i want to make a loop for
this DSH environment where you can work in a self improving iterative loop"). Deleting it as
written would have destroyed the origin record for the learning subsystem. The genuinely
blank session is `session-723f9bb4-8b66-4816-9771-93382a217862` — 880 bytes, 8 events,
created 2026-08-18 22:27, no title, no turns; its only content is a `/refine` status command
run on 2026-08-19 15:36, which makes it a second instance of the DSH-03 artifact. Confirmed
against `session.list`, which reports `blank: true, turns: 0, title: null` for it and
`blank: false, turns: 3, title: "hello"` for `43568c47`.

**Why the button cannot reach it.** Three gates compose, all upstream, none touched by the
fork:

- `ui-workspace/src/client/tree.ts:121` — `(!session.blank || session.id === current)`: a
  blank session is listed in the sidebar only while it is the *current* session.
- `ui-workspace/src/client/tree.ts:126` — blank rows are query-excluded, so search cannot
  reach it either (and content search reported itself unavailable regardless).
- `ui-workspace/src/client/rows/Rows.tsx:440` — `{!row.blank && (<span className={css.rowActions}><Menu ... />)}`:
  the entire row-actions menu is suppressed on a blank row. The in-code comment gives the
  reason — "the row verbs (rename/fork/archive) would all act on content that does not
  exist".

That reasoning is sound for the three upstream verbs and **wrong for the fork's fourth one**.
The fork added `{ id: 'delete', ... }` to `sessionMenuItems` at `Rows.tsx:388` — the one verb
whose target is the session log itself rather than its content, and therefore the one verb
that is *most* applicable to an empty session. It was added to a menu that blank rows never
render, so it inherited a suppression written before it existed.

Selecting the blank session does surface a row (via "New session in qwenTest", which
reuse-or-creates the workspace's blank session per the `startSession` contract), and the row
renders as "New Session" and selected — but with no trailing actions cell at all. Every other
row exposes a `Session actions for <title>` button; the blank row exposes none. Opening it
appended nothing: the log stayed 880 bytes at its original mtime.

No deletion was performed. Doing it by hand would satisfy the objective's letter while
destroying the evidence and skipping the acceptance criterion, which is specifically that the
UI button works.

**Decision: do not fix it.** A follow-up ticket to render Delete on blank rows was written and
then dropped the same day. The change itself is a few lines, but it lands in `Rows.tsx` — a
named rebase-conflict site in `FORK.md` — and would have to clear F's full 12,884-test suite
to remove one 880-byte file. Not worth the fork-diff growth or the rebase cost at this scale.
DSH-06 stays `BLOCKED` and the gap is recorded under Open decisions in `tasks.md`; revisit
only if blank sessions start accumulating, or fold it into the upstream contribution if that
ever happens.

---

## 2026-08-19 — Command-first sessions are upstream design, not a defect (DSH-03)

### W — no code changed; decision recorded

DSH-03 asked whether to fix the Web client's refusal to leave the New Session draft panel
when a session's first message is a slash command. **Decision: document the behavior and
close the ticket. Nothing in F was changed.**

The investigation settled the question the ticket left open. The behavior is deliberate
upstream design expressed at two sites, neither of which the fork has ever touched — `git
diff dsh-v0.1.0-rc.7` over `packages/client/runtime/src/client/sessions/session.ts` and all
of `packages/client/ui-conversation/` returns empty:

- `session.ts:788` — `hasVisibleConversationContent()` counts a chat node only when its
  `kind !== 'command'`, because "a generic command row alone remains control-plane content".
- `session.ts:248` — the blank bit flips on an accepted prompt; "standalone command and
  projection events never flip it".

A command-only session therefore holds `composerPhase === 'blank'` and `blank === true`,
which `ConversationRoot.tsx:80` reads as the hero and `ConversationSession.tsx:165` reads as
"render no rows at all". The missing result row and the unreachable stop control are one
consequence of one rule, not two bugs.

Why not fix it. The rule is right for quick control-plane commands (`/permission`, `/model`,
`/plan`, `/compact` should not evict the welcome hero) and wrong only for long-running ones
like `/refine`. Flipping the predicate is nearly a one-line change but inverts upstream
intent for every command on a blank session, and drags `session.ts` — a hot rebase-conflict
site — plus `ui-conversation/` into a fork diff that today is nothing but the
session-deletion seam. That seam is a live candidate for upstream contribution, whose point
is to eliminate the fork; an unrelated behavioral divergence works directly against it. A
narrower fix keyed on whether a command is cancellable has no classification to key off.

The workaround costs one sentence and is now the standing rule: **start a session with an
ordinary message, then send the command.** One prompt flips the blank bit permanently, and
every later command in that session renders and cancels normally. DSH-05 already carries
this instruction for the live `/redirect` pass.

Mechanism, view-layer trace, and the rejected alternatives are in `details.md` under "A
command-only session stays on the hero, by design (DSH-03)". Both checkouts were untouched
by this ticket; F was read with `git diff` and `git log` only.

---

## 2026-08-19 — The fork's cordis catalog matches its own source again (DSH-02)

### F `bec6782544` — Regenerate the committed cordis catalog

`5437c65bec` added `delete()` and `supportsDeletion` to the `SessionPersistence` seam but
never re-ran the catalog generator. The committed artifacts therefore described a seam that
no longer existed, and `packages/typert/generator/tests/cordis-catalog.spec.ts` failed its
"reproduces every committed catalog artifact byte for byte" assertion — the 42nd failure,
the only one on this machine that was a real gap rather than a missing OS privilege.

`corepack pnpm run gen-cordis-catalog` reported **93 artifacts computed, 3 written, 1 pair
record refreshed**, and the diff is exactly those two symbols:

- `docs/subsystems/persistence.md` and `.zh.md` — the `delete()` member and its JSDoc, into
  the generated region of both language sides.
- `docs/subsystems/persistence.i18n.yaml` — the translation-pairing hashes, re-recorded
  because both sides moved together.
- `packages/extensions/tool-cordis/src/api-catalog.ts` — `supportsDeletion` and `delete()`
  as runtime catalog entries.

**The ticket scoped the change to `docs/subsystems/` only; the generator also owns
`api-catalog.ts`.** That file is asserted on by the same spec (`renderRuntimeApi`), so
regenerating without it could not have made the test pass. The narrower scope in the ticket
was wrong, not the generator.

Verified: the spec passes 2/2 in 12s; F BUILT (`typecheck`, `build`) both exit 0. The
fork's environmental failure floor is now **41**, all of them this machine — no symlink
privilege, no PowerShell 7, one SDK-dependent spec, one timeout. Any count above 41 is a
regression from here.

This unblocks the upstream-contribution question in `tasks.md`: the fork's own gates are
green, so there is no longer a technical reason not to engage.

---

## 2026-08-19 — Interrupted campaigns reconcile at boot (DSH-01)

### W `b4f7e86` — Sweep mid-flight campaigns to `abandoned` on boot

`reconcileRescueReceipts()` only re-stated campaigns that left a `rolled-back-*.json`
receipt. A campaign whose process died while `collecting` leaves no receipt, so it kept
that state forever — and because `collecting` is a member of `closedOrActive` in
`selectRefinementObjective()`, the dead record **permanently suppressed its own
objective fingerprint**. Campaign `bcecaf0c-c0e9-4e90-b6de-8c73acbb4857` had been stuck
that way across three restarts.

`initialize()` now calls a second reconciler, `sweepInterruptedCampaigns()`, which moves
every campaign in `collecting`, `staged`, `validating`, `ready`, or `promoting` to
`abandoned` and records `sweptAtBoot` plus a checkpoint naming the state it died in.
`selectRefinementObjective()` ignores swept campaigns when deciding suppression, so the
objective becomes selectable again without new evidence.

Two states are deliberately exempt because both are legitimately cross-boot and have
their own resume paths: `waiting_restart` (absorbed by `markBootReady`) and
`needs_approval` (resumed by `/refine apply`, which reads the campaign straight from
storage).

**The ticket asked for a `startGeneration` field on the campaign record; it is not
there.** `initialize()` completes before any `/refine` can start a campaign, so by
construction every mid-flight row present at sweep time belongs to a process that has
already died. Comparing generations would have added a schema field, a migration for
existing rows, and no discrimination — the sweep is unconditional instead, and
`sweptAtBoot` records which boot performed it rather than gating it. That is the whole
reason the diff is 20 lines.

W BUILT green at **52 tests, 0 fail** (was 50; the learning suite goes 35 → 37).

---

## 2026-08-19 — Workflow and environment

### W `af55a08` — Adopt the Game repo's session workflow

Added `CLAUDE.md` and rewrote `tasks.md` into tickets. The pieces borrowed from
`E:\Game`: a doc map that names which file is spec and which is archive, an explicit
BUILT definition per repository, a stated risky boundary, the ticket format
(Objective / Existing context / Acceptance criteria / Files allowed to change /
Non-goals), and **one ticket per session, then `/clear`**.

The reason is the measured one in `~/.claude/CLAUDE.md` under Session economics: every
turn re-reads the whole conversation, so cost grows with the square of session length.
A ticket file that a cold session can load in one Read converts that recurring cost
into a one-time one. The rollout session that produced this entry is the argument for
it — it carried the full continual-learning implementation context through fifty-plus
turns of live acceptance, and almost none of that context was needed after the first
ten.

`finished_tasks.md` is now explicitly archive: grep it, never read it in. `AGENTS.md`
gained the same doc map so the rule is visible from either entry point. `tasks.md` also
picks up a **`### State at handoff`** convention — an interrupted ticket records live
PIDs, storage revisions, campaign IDs, and the exact resume command, so a future session
never has to reconstruct runtime state from conversation memory.

### Environment — corepack shims installed

`corepack pnpm run build` in the fork failed at its last step. `build:web` is written as
`pnpm --filter @deepseek-ai/dsh-web-frontend run build`, and that nested call resolves a
bare `pnpm`, which was on no PATH on this machine — "'pnpm' is not recognized".

`corepack enable` fails here with `EPERM` because it writes shims into
`C:\Program Files\nodejs`, which needs elevation. Installed them into the npm global bin
instead, which is already on PATH and user-writable:

```
corepack enable --install-directory 'C:\Users\Joony\AppData\Roaming\npm'
```

`pnpm --version` now reports 11.7.0 and `corepack pnpm run build` exits 0 end to end.
No PATH variable was modified and nothing was installed system-wide.

## 2026-08-19 — DSH native continual learning and reviewed refinement

### W `af55a08` — Add protected learning supervisor and `/refine`, enable full mode

Added `plugins/learning-supervisor.mjs`, its node:test suite, the protected
`plugins/learning/rescue/hidden-cases.mjs` corpus, the JSON-only mutable engine
and policy under `plugins/learning/mutable/`, and `tools/learning-rescue.ps1`.
Mounted the plugin in `deepseek-harness.yml` and armed the rescue helper from
both DSH launchers.

The supervisor owns storage, immutable task contracts, evidence hashing,
redaction, child restrictions, independent evaluation, bounded repair, lesson
lifecycle, refinement campaign validation, promotion, rollback, and restart
absorption. Mutable code receives validated JSON only and cannot weaken the
root of trust. Child agents have a 60-minute timeout and no added output token
cap.

The staged rollout completed on 2026-08-19 and the supervisor option moved from
`mode: lessons` to `mode: full`. The comment above that option was rewritten at
the same time: it still described `observe` mode and no longer matched the
value beneath it.

Rollout order note: the handoff checklist asked for a `/refine` campaign before
the mode switch, which is impossible — `refine()` returns early unless
`settings().mode === 'full'`, and the live run confirms it ("Refinement is
unavailable in lessons mode"). The campaign necessarily follows the switch.

Verification: 35/35 learning tests pass; both `node --check` targets are clean;
all four PowerShell scripts parse; the fork-CLI config dump exits 0 with the
supervisor mounted in `full`. Full-mode boot through `run-dsh-fork.ps1`
produced heartbeat generation 9 with `profile=web`, `selfCheck=true`, a
`runtimeBin` inside the Harness checkout, and supervisor/engine/policy hashes
matching the on-disk files exactly. Live `/refine status`, `pause`, `status`,
`resume`, `lesson approve`, and the mode gate all behave as specified. The
second independent recurrence evaluator finished with a passing episode; no
lesson auto-activated, correctly, because the two matching lessons carry
different fingerprints under different scopes.

The fork was checked but not changed: clean on `delete-session` throughout,
`typecheck` exit 0, build complete, full Vitest 12,883 passed / 42 failed — 41
environmental (no symlink privilege, no PowerShell 7, one SDK spec, one
timeout) and one real, pre-existing gap in the committed cordis catalog that is
now tracked in `tasks.md`. Nothing was committed, reset, cleaned, or pushed.

Two defects found during rollout are recorded in `tasks.md`: interrupted
campaigns are never reconciled to a terminal state, and the Web client will not
open a session whose first message is a slash command.

The first real `/refine` campaign, `64ff4138-12f9-4f7f-9b8c-87f33130acf8`, ran
2026-08-19 15:44:50 to 16:12:03 and ended `abandoned`. It was selected from backlog item
`f1f2174f-63ec-489b-823b-06526b161ecb` and never left `collecting`: the refinement worker
spent 61 steps and 75 read-only tool calls exploring the fork, hit its 32,768-token
output cap mid-reasoning (`turn/end` reason `max-tokens`, final step
`outputTokens: 32768` against ~160k of a 200k context), and never called
`learning_submit`. `captureStructured` saw no structured output and threw; the campaign
loop caught it and moved the campaign to `abandoned` with the note
`Refinement worker failed closed`.

No code changed as a result — this is an acceptance observation, not a fix. It confirms
the fail-closed path end to end: no patch was staged, no hash was recorded, no evaluator
ran, and both checkouts were untouched. It does not exercise the risk classifier,
validators, evaluator, or `needs_approval` gate, which stay unit-test-only for now. Two
design observations came out of it and are recorded in `details.md`: worker failure
bypasses `refinementRepairCycles` entirely, and this failure mode is distinct from the
reconciliation gap DSH-01 tracks. The token ceiling itself is now DSH-07 in `tasks.md`.

## 2026-08-19 — Local interrupt-and-steer command

### W `9642faf` — Add local redirect command

Added `plugins/command-redirect.mjs`, its four-case `node:test` suite, and an
absolute `file:///E:/...` plugin entry in `deepseek-harness.yml`. `/redirect`
constructs the replacement user message before cancellation, calls
`agent.cancel({ kind: 'user' })` without `keepInbox`, then calls
`agent.steer(message)` so the aborted driver latches exactly one next-turn wake.

The `file:///` spelling is required on Windows. A raw `E:\\...` absolute path
survived config parsing but failed at ESM import time with
`ERR_UNSUPPORTED_ESM_URL_SCHEME`; the file URL loads in a real Web-profile boot.
No Harness fork source changed and no rebuild was needed.

Verification: command tests 4/4 passed; patched config dump succeeded; real
Web profile booted; focused cancellation-convergence test passed (1 passed, 30
skipped). The remaining live browser acceptance pass is tracked in `tasks.md`
because the available in-app browser blocks localhost.

### W — live browser acceptance pass (DSH-05, 2026-08-19)

`/redirect` accepted against a real running turn in the Web UI. No code changed; the
plugin behaved as designed, so `plugins/command-redirect.mjs` was left untouched.

Session `session-5286705d-c21c-46c2-b751-321cb934d84a`, started with an ordinary message
(the DSH-03 rule). One long turn was put in flight, one sacrificial follow-up was queued
into `next-turn` while it ran, then `/redirect change direction` was submitted. The
session log records all four required outcomes in one contiguous window:

```
2495 command/run          redirect
2496 agent/inbox/spliced  removedCount 1, outcome "canceled"   <- follow-up discarded
2497 agent/inbox/spliced  inserted "change direction"          <- only the redirect queued
2498 command/done         success "Current task interrupted; redirect queued."
2500 turn/end             turn 1, reason.kind "aborted", reason.reason.kind "user"
2501 turn/start           turn 2
2502 agent/inbox/spliced  removedCount 1                       <- turn 2 drains one item
```

The UI matches: the original turn's row is marked `Stopped`, the redirect renders as a
command row rather than a user row (`recordInput: false`), and the sacrificial follow-up
never appears at all.

Both error paths were exercised on the same session after the redirect turn was stopped,
and both produced a `command/run` + `command/done kind: "error"` pair with no `turn/start`
between them:

```
2504/2505  /redirect <text> while idle  -> "No task is running. Use a normal message instead."
2506/2507  /redirect with no argument   -> "Redirect instructions are required. Usage: /redirect <instruction>"
```

Two mechanics worth knowing before repeating this pass are recorded in `details.md` under
"Queueing a follow-up during a running turn": an ordinary running session has no Send
button, so Enter is the only way to queue, and a bare `/redirect` needs two Enters because
the command menu consumes the first one to complete the token.

---

## 2026-08-18 — Session delete button

### F `3ae22c5013` — docs: make the fork's git contract obvious to any agent

Added `FORK.md` and a banner at the top of the fork's `AGENTS.md`. `origin`
points at upstream deepseek-ai with no fork remote, the default branch is
`master` not `main`, and the built output the launcher runs is gitignored — an
agent arriving cold could push, commit on `master`, or clean away the build
without knowing any of it.

Also added `.agent-results/` and `.serena/` to `.git/info/exclude` rather than
`.gitignore`, so the tracked ignore file stays byte-identical to upstream and
never conflicts on rebase.

### F `f57dd99bba` — fix(apiproxy): make session deletion actually reachable

End-to-end testing against a running harness found the feature unreachable in
two independent ways, both invisible to the unit tests because they compose a
mocked cordis `Context`:

- The seam was read as bare `ctx.sessionPersistence`, an undeclared injection,
  so cordis threw `cannot get property without inject` on every delete that got
  past the liveness guard. Now uses the optional `ctx.get('sessionPersistence')`
  accessor the file already uses elsewhere.
- The liveness guard refused any session resident in `ctx.sessions`. The list
  path hydrates every served session into the store, so *every row the sidebar
  displayed* was undeletable. Now guards on
  `ctx.agents.get(id)?.status === 'running'`.

The existing refusal test asserted the second bug as intended behavior, which is
why the suite ratified it; it now covers a running session. Two regression tests
added for what the mocks hid.

### F `5437c65bec` — feat(session): add a delete action for persisted sessions

30 files, +639/−13. Menu → wire → disk, mirroring `session.fork`: an optional
deletion capability on the persistence seam, real removal in the jsonl backend,
`session.delete` across the api-proxy wire files, `ISessions.delete` in the
client runtime, and a destructive row-menu entry behind a confirmation dialog
(en + zh). Archive behavior unchanged.

### W `65f95bc` — Add launchers for the local harness fork

`run-dsh-fork.ps1` runs the fork's built CLI by absolute path so the process
working directory stays the project rather than the checkout — `deepseek-harness.yml`
derives the sandbox `workspaceRoot` from `process.cwd()`, so launching from
inside the checkout would silently re-root the model's write sandbox at the
harness source. `run-all.ps1` gained `-Fork`; `run-all-fork.bat` is the
double-clickable form, since `run-all.bat` forwards no arguments and would
otherwise keep using the npm package.

The npx path stays the default and the fallback.

---

## 2026-08-18 — Environment

### `~/.claude/settings.json` — MCP idle timeout raised

Added `env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = "3600000"` (3600 s, expressed in
ms). There was no `env` block before and the variable was unset in every scope,
so Codex workers had been running on the built-in default. Applies to newly
started sessions only. Note it caps the *idle* gap between MCP messages, not
total call duration — a worker that streams progress can run far longer without
tripping it.

---

## 2026-08-19 — DSH-08: local Harness upgraded and accepted on rc.8

F now sits on `dsh-v0.1.0-rc.8` (`141eb6fef8`) with the session-delete fork
replayed and rollback branch `codex/delete-session-rc7-backup` pinned at
`bec6782544`. The generated Cordis catalog verifies, typecheck and build exit 0,
and the focused delete-path run passes 753 tests in 33 files. The full suite
passes 13,508 tests in 803 files; the remaining 33 failures are 32 Windows
symlink-privilege cases plus the known persistent-PowerShell timeout.

W now pins the published fallback at `@deepseek-ai/dsh@0.1.0-rc.8`, while
`run-all.bat` defaults to the customized fork. `run-all-published.bat` and
`run-all.ps1 -Published` preserve an explicit published-rc.8 fallback; `-Fork`
remains a compatible alias and is mutually exclusive with `-Published`.

Deployment acceptance passed all 55 plugin tests, PowerShell parsing, rc.8
configuration loading, and pre/post SHA-256 comparison for every plugin and
user skill. Live Web checks covered `/doctor`, `/refine status`,
`/ponytail-help`, and an active-turn `/redirect`. The throwaway top-level
session `session-e8e5666e-3eae-4d7f-9a6f-3c964f395aae` was confirmed and
deleted through the Web UI; its directory is gone. The JSONL backend does not
cascade deletion to subagents, so detached child
`2a5e1545-f173-43cb-bcd3-ceb5e97a48eb` remains as documented follow-up evidence
rather than being removed outside the UI.

No push, global DSH install, credential/security change, production-binary
replacement, or DSH-06 session deletion occurred. Existing dirty worktrees
were preserved; F's intended `FORK.md` rc.8 update remains uncommitted under
the repository's no-commit rule.

---

## 2026-08-20 — Central Beads, GitNexus, and Serena/clangd tooling

Installed pinned `@beads/bd@1.2.2` and `gitnexus@1.6.9`, preserving the existing Serena
Codex hooks. The central server-mode Dolt tracker at `E:\local-qwen-tracker` now owns the
nine actionable open items, including the DSH-09 live replay and the DSH-06 blocker edge.
W, F, and L redirect to that database through ignored local files.

GitNexus analysis is local and grouped as `local-qwen`; llama.cpp development uses an
ignored SM89 CUDA build, compilation database, and Serena clangd project. Upstream push is
disabled locally for L. The b10524 CUDA targets built cleanly and their focused CTest gate
passed 2/2. Nsight Systems 2026.3.1.157 and Nsight Compute 2026.2.1 were staged as isolated
images with verified CLIs and no PATH mutation; Windows administrator sampling and NVIDIA
performance-counter permissions remain opt-in. Context7 credential rotation and Codex
hook trust remain explicit user-side prerequisites rather than being automated or logged.
