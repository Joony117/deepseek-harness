# Finished tasks

Completed work, newest first. Commit hashes and per-change rationale are in
[change_log.md](change_log.md); technical depth is in [details.md](details.md).

---


## DSH-07 — Give the refinement worker room to submit                    [DONE]

### Objective
A `/refine` refinement worker reaches `learning_submit` instead of dying at its output
cap, so a campaign can get far enough to be staged and judged.

### Existing context
- Campaign `64ff4138-12f9-4f7f-9b8c-87f33130acf8` (DSH-04) is the only real campaign run
  so far. It ended `abandoned` without staging anything: 61 steps, 75 read-only tool
  calls, ~754k characters of reasoning, and a final step at `outputTokens: 32768` —
  exactly the configured `maxTokens` — with `turn/end reason.kind = "max-tokens"`.
- Context was **not** the binding limit: ~160k used of a 200k window. The per-response
  output cap is what stopped it.
- The worker is dispatched by `refinementWorker` via the `captureStructured` helper in
  `plugins/learning-supervisor.mjs`; `captured === undefined` throws at
  `plugins/learning-supervisor.mjs:756`, and the campaign loop abandons at
  `plugins/learning-supervisor.mjs:1718`.
- `SUPERVISOR_LIMITS` carries `refinementWorkerTimeoutMs` and `refinementRepairCycles`
  but no token budget. `maxTokens: 32768` and `reasoningEffort: medium` come from the
  `local-qwen` provider config, not from the supervisor.
- `refinementRepairCycles: 2` does **not** cover this: worker exceptions `return`
  immediately from the loop rather than consuming a repair generation.
- The abandoned campaign now **suppresses its own objective**: `abandoned` is a member of
  the `closedOrActive` set at `plugins/learning-supervisor.mjs:1666`, so backlog item
  `f1f2174f-63ec-489b-823b-06526b161ecb` cannot be reselected unless its `evidenceCount`
  rises above 8. Expect to exercise this against a different objective, or to raise
  evidence first.

### Acceptance criteria
- Decide and record the approach in `change_log.md`. The candidates, cheapest first:
  lower `reasoningEffort` for the refinement child; cap exploration by tightening the
  worker prompt or the read budget; let a worker that ends on `max-tokens` consume a
  repair generation instead of abandoning outright.
- Whatever lands, a worker that stops on `max-tokens` must still fail closed — never
  stage or promote on partial output.
- New unit coverage for the chosen path, including the fail-closed assertion.
- W BUILT goes green; the learning suite grows by the number of new tests.

### Files allowed to change
`plugins/learning-supervisor.mjs`, `plugins/learning-supervisor.test.mjs`, and
`deepseek-harness.yml` only if the decision is a provider-config change.

### Non-goals
Do not raise `maxTokens` blindly — 32,768 output tokens in one step is already a symptom,
not a shortage. Do not add a token accountant, a budget-tracking storage table, or
per-step metering. Do not touch `plugins/learning/rescue/**` or the rescue helper.

### Outcome
Landed 2026-08-19. A worker exception now consumes a repair generation instead of ending the
campaign: the failure text becomes the next generation's `findings` entry, `previous` is
cleared, and the final generation (or an aborted signal) still abandons. Fail-closed holds by
construction — the `catch` ends in `continue`, so `manifest` stays `undefined` and
`stageManifest` is unreachable from a partial run. Lowering `reasoningEffort` was rejected
(provider-wide, no per-child seam) and a read budget was rejected (new accountant, a stated
non-goal). Rationale in `change_log.md`; W BUILT green at 55 tests.

---
## DSH-05 — Live `/redirect` browser acceptance pass                      [DONE]

### Objective
`/redirect` proven against a real running turn in the browser.

### Existing context
- Unit tests (4/4), config loading, real Web-profile boot, and the focused
  cancellation-convergence test all pass already. Only the live pass is missing.
- The earlier blocker is gone: the in-app browser can now reach `http://127.0.0.1:3080`,
  which is how the `/refine` surfaces were accepted on 2026-08-19.
- **Start the session with an ordinary message, not a command**, or the conversation view
  will not open. This is upstream design, not a bug — settled and documented in DSH-03;
  the mechanism is in `details.md`.

### Acceptance criteria
- Start a long-running turn, queue a sacrificial follow-up, then submit
  `/redirect change direction`.
- Confirm: the original turn is user-aborted; the follow-up is discarded; only the redirect
  starts next; and idle or empty invocations create error command rows without a model turn.
- Result recorded in `change_log.md` under the existing `/redirect` entry.

### Files allowed to change
`change_log.md`, `details.md`, `tasks.md`.

### Non-goals
Do not change `plugins/command-redirect.mjs` unless the live pass finds a defect.

---

## DSH-03 — Open sessions whose first message is a slash command          [DONE]

### Objective
Sending a command as a session's first message lands you in the conversation view, with the
command's result row visible and the stop control reachable.

### Existing context
- Today the session is created and the command genuinely runs — `session.create` and
  `commands/execute` both return 200 and the result text comes back — but the client keeps
  rendering the New Session draft panel.
- Consequences: the command's result row is never displayed, and there is no way to stop a
  long-running command. A `/refine` campaign started this way can only be killed by
  restarting the harness.
- Reproduced against `session-14e38e2d-3e67-48b5-82e2-10fd3ef24617` (seven commands, none
  ever rendered) and `650c8b89-ae74-4198-a0f1-6b578a83c591`.
- **Not caused by the learning plugin.** Any command behaves this way, so the fix is in the
  fork's client, which makes this a rebase-surface decision as much as a bug fix.

### Acceptance criteria
- Decide first, and record the decision in `change_log.md`: fix in the fork, or document the
  behavior and close this ticket. Widening the fork's diff has a standing cost — see the
  upstream-contribution question in Open decisions.
- If fixed: a command-first session opens in the conversation view, its result row renders,
  and the stop control cancels a running command.
- If fixed: F BUILT exits 0 and the fork test count does not rise.

### Files allowed to change
To be determined by the decision. Likely `packages/client/ui-workspace/`.

### Non-goals
Do not change command execution, registration, or the `/refine` surface — the server side
is correct.

### Resolution — documented, not fixed (2026-08-19)
The premise in "Existing context" was wrong on one point: this is **not** a fork defect and
the fix would not have been in `ui-workspace/`. It is deliberate upstream design at
`packages/client/runtime/src/client/sessions/session.ts:788` and `:248`, both in files the
fork has never touched (`git diff dsh-v0.1.0-rc.7` over that file and all of
`packages/client/ui-conversation/` is empty). A command is control-plane content by design,
so it does not flip `composerPhase` off `blank` — and `ConversationSession.tsx:165` then
renders no rows at all.

Decision: document and close. Fixing it inverts upstream intent for every command on a
blank session and widens a fork whose direction is to be upstreamed and dropped. The
workaround is one sentence — start with an ordinary message, then send the command — and is
now the standing rule, already carried in DSH-05. No code changed in either checkout; the
second half of the acceptance criteria (F BUILT, test count) does not apply. Full mechanism
in `details.md`, decision in `change_log.md`.

---

## DSH-01 — Reconcile interrupted campaigns to a terminal state          [DONE]

### Objective
A `/refine` campaign whose process dies before promotion ends up in a terminal state on the
next boot, instead of blocking its objective forever.

### Existing context
- `LearningSupervisor.initialize()` calls `reconcileRescueReceipts()`
  (`plugins/learning-supervisor.mjs:811`), which only re-states campaigns that left a
  `rolled-back-*.json` receipt in `~/.dsh/learning/rescue/`.
- A campaign killed while `collecting` leaves no receipt, so it keeps that state forever.
- `selectRefinementObjective()` treats `collecting` as a member of `closedOrActive`, so the
  dead campaign **permanently suppresses its own objective fingerprint** — the objective can
  never be selected again unless new evidence raises its `evidenceCount`.
- The storage domain carries `bootGeneration`, incremented once per boot in `initialize()`.
  Campaign records do not currently store the generation they started under.
- Live instance: campaign `bcecaf0c-c0e9-4e90-b6de-8c73acbb4857`, stuck `collecting` across
  three restarts. Created by an input mistake during acceptance (stale composer text
  submitted `/refine` with the focus `status/refine status`), so the objective it suppresses
  is meaningless and no real work is blocked. Use it as the fixture.

### Acceptance criteria
- On boot, any campaign in a non-terminal state (`collecting`, `staged`, `validating`,
  `ready`, `promoting`) that started under an earlier `bootGeneration` is moved to
  `abandoned` with a checkpoint recording why.
- `waiting_restart` is **not** swept — that state is legitimately cross-boot and is what
  `markBootReady` absorbs.
- A campaign swept this way no longer suppresses its objective fingerprint.
- `bcecaf0c-c0e9-4e90-b6de-8c73acbb4857` reads `abandoned` after one restart.
- New unit coverage for the sweep and for the `waiting_restart` exemption.
- W BUILT goes green; the learning suite grows past 35 by the number of new tests.

### Files allowed to change
`plugins/learning-supervisor.mjs`, `plugins/learning-supervisor.test.mjs`.

### Non-goals
Do not add a `/refine abort` command, a campaign TTL, or any cleanup of the staged
directories under `~/.dsh/learning/refine/`. Do not hand-edit `dsh_learning.json`.

### Outcome
Landed as `sweepInterruptedCampaigns()` in `plugins/learning-supervisor.mjs`, called from
`initialize()` before the `bootGeneration` bump. `sweptAtBoot` was added to the campaign
schema and `selectRefinementObjective()` now ignores swept campaigns when deciding
suppression. `needs_approval` is exempt alongside `waiting_restart` — `/refine apply`
reads a `needs_approval` campaign straight from storage, so it resumes across a boot.

The `startGeneration` field this ticket sketched was **not** added: `initialize()`
completes before any `/refine` can start, so every mid-flight row present at sweep time
belongs to a dead process by construction. The sweep is unconditional and `sweptAtBoot`
records which boot performed it.

Live acceptance on boot generation 10: `bcecaf0c-c0e9-4e90-b6de-8c73acbb4857` reads
`abandoned` with `sweptAtBoot=10`, and `~/.dsh/learning/refine/bcecaf0c-.../
checkpoint-001-abandoned.json` carries the note "Interrupted in collecting by a harness
restart; swept at boot generation 10". Campaign `64ff4138` was already `abandoned` before
the sweep and was left untouched, with no `sweptAtBoot` — a genuine failed attempt still
suppresses its objective, which is the intended behavior.

W BUILT green at 52 tests, 0 fail (was 50; learning 35 → 37).


---

## DSH-04 — Finish the first `/refine` campaign acceptance                [DONE]

### Objective
One low-risk `/refine` campaign observed end to end, with its manifest, validators, hashes,
and terminal state recorded in `details.md`.

### Existing context
- Campaign `64ff4138-12f9-4f7f-9b8c-87f33130acf8` is the run in progress, selected from
  backlog item `f1f2174f-63ec-489b-823b-06526b161ecb` ("Have session tool events record the
  explicit exit code of executed commands so evaluators need not infer it from runner
  output").
- Its frozen contract is correct: objective from the backlog, three acceptance claims, four
  non-goals, both repo roots as `permittedRoots`, the full `SUPERVISOR_LIMITS`, and a git
  baseline of both checkouts. Staged at
  `~/.dsh/learning/refine/64ff4138-12f9-4f7f-9b8c-87f33130acf8/`, outside both repositories,
  with `checkpoint-000-collecting.json` written.
- The objective targets Harness behavior, so the candidate will most likely classify
  `risky` and stop at `needs_approval`. That is a valid terminal state to record.

### State at handoff
- Started 2026-08-19 15:44 local, still `collecting` at 16:07 when the session that
  launched it was cleared. The refinement worker child is session
  `5a817370-c217-4b48-b8e7-d996c778c4c2`; its log was growing steadily (1.27 MB at 16:07),
  so it is working, not hung. Child timeout is 60 minutes, i.e. it gives up by 16:44.
- Nothing is watching it any more. If the poll below returns `collecting` after 16:44, the
  worker timed out and the campaign is stranded exactly as DSH-01 describes.
- Harness PID owns port 3080, launched by `run-dsh-fork.ps1`, heartbeat generation 9.
  **Restarting the harness kills this campaign** and, until DSH-01 lands, strands it in
  `collecting` forever.
- Resume by polling:
  `node -e "const d=require('C:/Users/Joony/.dsh/storages/dsh_learning.json');console.log(d.tables.campaigns['64ff4138-12f9-4f7f-9b8c-87f33130acf8'].state)"`

### Acceptance criteria
- Campaign reaches a terminal state (`absorbed`, `needs_approval`, `no_op`, `abandoned`, or
  `rolled_back`).
- Its manifest, validator results, hashes, and terminal state are recorded in `details.md`
  under the full-mode acceptance record, replacing the `CAMPAIGN_PLACEHOLDER` markers there
  and in `finished_tasks.md` and `change_log.md`.
- If it reaches `needs_approval`, inspect it with `/refine status <id>` and **do not
  approve it** — this ticket is about observing the gate, not promoting a change.

### Files allowed to change
`details.md`, `finished_tasks.md`, `change_log.md`, `tasks.md`.

### Non-goals
Do not run `/refine apply`. Do not start a second campaign. Do not start a broad Harness
edit to demonstrate risk gating — that path already has unit coverage.

### Outcome
Reached the terminal state `abandoned` at 2026-08-19 16:12:03, 27m13s after start,
without ever leaving `collecting`. The refinement worker exhausted its 32,768-token
output cap mid-reasoning on step 61 and never called `learning_submit`, so the supervisor
failed closed. Manifest, validators, hashes, and the full root-cause trace are recorded in
`details.md` under the full-mode acceptance record. No `/refine apply` was run and no
second campaign was started; both checkouts were untouched. The token ceiling it exposed
is now DSH-07.

---

## DSH native continual learning — rolled out in full mode — 2026-08-19

**Goal.** Give DSH agents frozen task contracts, independent outcome
evaluation, bounded repair, durable episodes/lessons/backlog, and a reviewed
`/refine` self-improvement loop with an immutable rescue boundary.

**Implemented.** Added the protected supervisor and hidden evaluator corpus,
the JSON-only mutable engine/policy, storage-domain schemas and serialized
writes, evidence references, redaction and project scoping, fresh child roles,
clarification gating, immutable contracts, same-turn repair steering,
stagnation/oscillation stops, lesson promotion/contradiction/retirement,
deterministic retrieval, all `/refine` commands, external staging, risk and
path enforcement, hash-guarded promotion/rollback, Harness detached-worktree
validation, and restart heartbeat/rescue handling. Launcher integration exists
for both npm and fork paths. No Harness fork source was changed.

**Safety hardening.** Security decisions and hard caps are owned by the
immutable supervisor. The mutable engine can rank only supervisor-validated
lesson IDs and existing objectives; tests prove it cannot inject lesson text,
invent an objective, or weaken protected paths. Children receive no unrestricted
context, shell, credentials, package manager, or promotion authority.

**Model allowance.** Contract/evaluator/refinement children have a 60-minute
timeout and inherit the parent's model options without a learning-specific
output-token ceiling. The local llama server remains at a 200,000-token context
with full GPU offload, quantized KV cache, and memory mapping; this preserves
the user's requested thinking room without allocating another model copy.

**Rolled out.** `deepseek-harness.yml` carries `mode: full`. The harness boots
from the fork CLI through `run-dsh-fork.ps1` and writes a protected heartbeat at
generation 9 with `profile=web`, `selfCheck=true`, and a `runtimeBin` inside the
Harness checkout. The heartbeat's supervisor and engine hashes and the storage
domain's policy hash match `sha256sum` of the three on-disk files exactly.

**Verified.** Unit result is 35 passed, 0 failed, with both `node --check`
targets clean, all four PowerShell scripts parsing, and a fork-CLI config dump
exiting 0 with the supervisor mounted in `full` mode. Live against the real Web
client: `/refine status`, `pause`, `status`, and `resume` all behave as
specified, and `/refine lesson approve` moved a candidate to `active` with
`handApproved: true`. The mode gate is real — a bare `/refine` in `lessons`
mode is refused, which also means a campaign cannot be exercised before the
mode switch. The original handoff checklist had that order backwards.

**Learning actually happened.** The second independent recurrence session
finished with a passing episode and produced three more candidate lessons. No
lesson reached `active` on its own, and that is correct behavior rather than a
gap: the two lessons capturing the same sandbox `spawn EPERM` finding got
different fingerprints because one was forced to `project` scope by an absolute
path in its own text. Exact fingerprints merge; near-duplicates wait for
`/refine`. One lesson the run generated — quote a file reader's line count
instead of counting by hand — was a direct response to a factual slip in that
same turn's frozen contract.

**Fork left untouched.** `E:\deepseek-harness` was clean and on `delete-session`
before and after. `typecheck` exits 0 and the build completes. The full Vitest
suite is 12,883 passed / 42 failed; 41 of those failures are this machine
(no symlink privilege, no PowerShell 7, one SDK-dependent spec, one timeout).
The 42nd is real and pre-existing: the committed cordis catalog under
`docs/subsystems/` was never regenerated after the session-delete seam added
`delete()`, so the byte-for-byte catalog test fails. It is in `tasks.md`.

**Two defects found during rollout,** both in `tasks.md`: a campaign
interrupted before promotion is never reconciled to a terminal state and
permanently suppresses its own objective fingerprint; and the Web client will
not open a session whose first message is a slash command, which hides the
command's result row and puts the stop control out of reach.

**First `/refine` campaign, observed end to end.** Campaign
`64ff4138-12f9-4f7f-9b8c-87f33130acf8`, selected from backlog item
`f1f2174f-63ec-489b-823b-06526b161ecb` (record explicit command exit codes on session
tool events), reached the terminal state **`abandoned`** after 27m13s. Nothing was
staged, so `patchManifest`, `targetFiles`, `hashes`, `promotedHashes`, and `evaluator`
are all empty; the single validator entry is
`{ name: "worker", ok: false, detail: "learning refinement worker ended without valid
structured output" }`. The worker exhausted its 32,768-token output cap mid-reasoning on
step 61 — 75 read-only tool calls, ~754k characters of reasoning, `turn/end` reason
`max-tokens` — and never called `learning_submit`. The supervisor failed closed and
reconciled the campaign itself; both checkouts were untouched throughout. Full record,
including the two design observations it surfaced, is in `details.md`.

## Local `/redirect` interrupt-and-steer command — 2026-08-19

**Goal.** Add a deployment-local slash command that replaces active work rather
than merely appending guidance to the current turn.

**Outcome.** `/redirect <instruction>` now rejects empty or idle use, cancels a
running turn with user-abort semantics, clears all pending inbox work, and
queues one normalized user message as the replacement turn. It lives entirely
in the deployment plugin and configuration; no Harness source, public type,
wire schema, dependency, or rebuild changed.

### Verified

- [x] Plugin unit suite: 4 passed, 0 failed
- [x] Patched configuration resolves the absolute plugin entry
- [x] Real fork Web profile boots with the plugin loaded
- [x] Focused Harness cancellation-convergence regression: 1 passed, 30 skipped
- [ ] Live browser interaction remains in [tasks.md](tasks.md); the Codex
      in-app browser blocks localhost and explicitly prohibited an alternate
      browser workaround

### Limits

The command accepts text only and acknowledges admission immediately.
Cancellation is cooperative, so an abort-insensitive provider or tool can delay
the replacement turn. External side effects already started are not rolled
back. Repeated redirects during cancellation are replace-all: the latest
invocation clears the earlier pending replacement.

---

## Session delete button for the harness Web UI — 2026-08-18

**Goal.** Add a GUI action to delete a persisted session from the DeepSeek
Harness sidebar.

**Outcome.** Shipped and verified against a live harness. Row menu is now
Rename / Fork / Archive / **Delete**, with a confirmation dialog.

### What was established first

- Deletion existed nowhere in the stack — not in the persistence seam, the
  session store, the client interface, or the shipped frontend bundle. Archive
  hides a row; `workspace.delete` explicitly keeps session logs.
- The npm package publishes build output only, so a button was impossible
  out-of-tree. A `/delete-session` slash command via `ctx.commands` *was*
  possible; the fork was chosen deliberately after that trade-off was stated.
- Session data already survives harness updates — it lives in `~/.dsh`, not in
  the npx cache. Nothing needed building for that.

### Steps completed

- [x] Cloned upstream to `E:\deepseek-harness`, branched `delete-session` off
      tag `dsh-v0.1.0-rc.7` — the exact version in use, so the fork starts at
      zero drift
- [x] `corepack pnpm install` (exit 0)
- [x] Implemented the feature across seam, backend, wire, client runtime, UI
- [x] Launchers wired so the fork is runnable without disturbing the npx path
- [x] `pnpm run typecheck` exit 0, verified independently rather than relayed
- [x] `pnpm run build` completed — required, since it emits the browser bundle
      that actually carries the button
- [x] Drove the real UI: menu → dialog → confirm
- [x] **Found two defects that every unit test missed**, fixed both, added
      regression tests
- [x] Confirmed on disk: throwaway session directory removed, real session
      intact
- [x] Documented the fork's git contract for agents arriving cold

### Verified end-to-end

| Case | Result |
|---|---|
| Idle session | deleted; row removed without reload; directory gone |
| Running session | refused; dialog stays open; error surfaced in-dialog |
| No persistence backend | clean `session-delete-unsupported`, no throw |

Final suite state: typecheck 0; apiproxy 383 passed; ui-workspace 123 passed;
persistence 137 passed; client-runtime 45 passed.

### Lesson worth keeping

The feature shipped green — typecheck clean, 350+ tests passing — and was
**completely non-functional**. Every test composed a mocked cordis `Context`, so
neither the injection rule nor real store hydration applied, and one test
asserted the broken guard as correct behavior. Clicking the button once found
both defects in about ten minutes. Treat a green suite here as necessary, never
sufficient.

---

## Environment — 2026-08-18

- [x] Raised `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` to 3600000 ms in global user
      settings for long-running Codex work (new sessions only)

---

## DSH-02 — Regenerate the fork's committed cordis catalog               [DONE]

### Objective
`packages/typert/generator/tests/cordis-catalog.spec.ts` passes, taking the fork's real
test failure count from 42 to 41.

### Existing context
- The spec asserts "reproduces every committed catalog artifact byte for byte".
- Adding `delete()` and `supportsDeletion` to the session-persistence seam in `5437c65bec`
  (2026-08-18) changed the generated cordis surface.
- The committed artifact under `E:\deepseek-harness\docs\subsystems\` was never
  regenerated: it contains no mention of either symbol, and the last commit touching that
  directory is an upstream merge, not `5437c65bec`.
- The generator is `corepack pnpm run gen-cordis-catalog`; `verify-cordis-catalog` is the
  `--check` form used by the fork's own gates.
- This is pre-existing and unrelated to the learning work, which touches no fork source.

### Acceptance criteria
- `corepack pnpm run gen-cordis-catalog` run in the fork, diff inspected before committing.
- `corepack pnpm exec vitest run packages/typert/generator/tests/cordis-catalog.spec.ts`
  passes.
- F BUILT (`typecheck` and `build`) still exit 0.
- One commit on `delete-session` in the fork. **Confirm the branch and that `origin` is
  upstream before committing; never push.**

### Files allowed to change
Only what `gen-cordis-catalog` writes under `E:\deepseek-harness\docs\subsystems\`.

### Non-goals
Do not fix the other 41 failures — they are this machine (no symlink privilege, no
PowerShell 7, one SDK-dependent spec, one timeout). Do not regenerate any other catalog.

---

## DSH-08 — Upgrade local DeepSeek Harness deployment to rc.8       [DONE]

### Objective
The customized local Harness runs `dsh-v0.1.0-rc.8` with the session-delete
fork, deployment plugins, MCP tools, commands, learning loop, and user skills
preserved and accepted end to end.

### Existing context
- F is `E:\deepseek-harness`, branch `delete-session`, previously based on
  `dsh-v0.1.0-rc.7`; rollback is pinned at
  `codex/delete-session-rc7-backup` = `bec6782544`.
- Upstream rc.8 is `141eb6fef8`; the public plugin surfaces used by the local
  commands and learning supervisor remain compatible.
- W has one pre-existing untracked file, `plugins/README.md`; it is user-owned
  and must not be staged by this ticket.
- TypeScript Language Server 5.3.0 and TypeScript 7.0.2 are installed in the
  user npm prefix. Both W and F index successfully through Serena's TypeScript
  backend.

### Acceptance criteria
- F is rebased onto `dsh-v0.1.0-rc.8`, clean, typechecks, builds, regenerates
  the Cordis catalog, and passes the focused delete-path suites with no
  fork-attributable full-suite regression.
- W's 55 plugin tests pass; PowerShell launchers parse; the rc.8 CLI loads
  `deepseek-harness.yml`; pre/post plugin and skill hashes match.
- `run-all.bat` selects the customized fork by default and an explicit
  published-rc.8 fallback remains available.
- Live acceptance covers `/doctor`, `/refine status`, `/redirect`, one user
  skill invocation, and deletion of a throwaway nonblank session through the
  Web UI. Ports 8080 and 3080 are idle at handoff.

### Files allowed to change
- W launchers and the canonical spec set at the repository root.
- F's existing session-delete seam, generated catalog, `FORK.md`, and synced
  spec-set copies only as required by the rc.8 rebase.
- W's ignored `.serena/project.yml` for the TypeScript language server.

### Non-goals
Do not push, globally install DSH, change credentials or security policy,
alter existing sessions or learning state, delete DSH-06's blank session,
enable SQLite deletion, or make `/redirect` accept attachments.

### Acceptance record

- Fork base: `dsh-v0.1.0-rc.8` (`141eb6fef8`); rollback branch
  `codex/delete-session-rc7-backup` (`bec6782544`).
- Cordis catalog verification, typecheck, and build exited 0. Focused suites:
  33 files and 753 tests passed.
- Full suite: 803 files and 13,508 tests passed; all 33 failures classified as
  Windows symlink privilege or the known persistent-PowerShell timeout.
- Deployment: 55 tests passed; four launchers parsed; rc.8 config dump loaded;
  plugin and skill hashes matched.
- Live UI: `/doctor`, `/refine status`, `/ponytail-help`, in-flight `/redirect`,
  and confirmed deletion of the throwaway top-level session passed.
- The planned dirty worktrees were preserved. F therefore retains the intended
  uncommitted `FORK.md` documentation update rather than violating the repo's
  no-commit rule; no unexpected tracked changes were introduced.
- JSONL deletion is non-cascading. The deleted throwaway's detached subagent
  artifact remains documented in `details.md` for a separate UI-safe cleanup.
