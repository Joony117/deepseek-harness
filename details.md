# Details — local Harness deployment and fork

Durable technical reference for the local DeepSeek Harness fork. Written
2026-08-18; updated 2026-08-19. Companion files: [tasks.md](tasks.md),
[finished_tasks.md](finished_tasks.md), [change_log.md](change_log.md).

## Two repositories

| Path | Role | Branch | Remote |
|---|---|---|---|
| `E:\Qwen3.8_27b` | This workspace: llama.cpp server, launchers, harness config | `main` | none |
| `E:\deepseek-harness` | Fork of the harness itself | `delete-session` | `origin` = **upstream** deepseek-ai |

The fork's git contract lives in `E:\deepseek-harness\FORK.md`, and its
`AGENTS.md` carries a banner pointing there. Short version: never push, never
commit on `master`, base tag is `dsh-v0.1.0-rc.7`.

## Native continual learning and reviewed self-refinement

The deployment-local `plugins/learning-supervisor.mjs` implements the learning
loop without adding a database, runtime, dependency, or Harness-fork patch. It
uses one versioned `ctx.storageDomain` domain named `dsh_learning`; serialized
writes live in `%USERPROFILE%\.dsh\storages\dsh_learning.json` and contain
contracts, evidence references, episodes, lessons, backlog items, campaigns,
and global settings. Raw session content stays in the existing DSH session
store and is referenced by session/event ranges and hashes rather than copied.

### Trust boundary

The immutable side is:

- `plugins/learning-supervisor.mjs`: schemas, hard caps, redaction, scoping,
  contract freezing, child isolation, write boundaries, validation, promotion,
  and rollback;
- `plugins/learning/rescue/hidden-cases.mjs`: regression corpus whose expected
  results are never placed in worker context;
- `tools/learning-rescue.ps1`: pre-launch heartbeat watcher and exact-byte
  restoration.

The self-editable side is only `plugins/learning/mutable/**`: declarative prompt
policy and pure JSON ranking/grooming logic. It receives no Cordis context,
filesystem, shell, credential, storage, or promotion handle. Its suggestions
are treated as untrusted input by the supervisor. In particular, mutable code
may rank lesson IDs and open backlog objectives, but it cannot supply lesson
text, invent objectives, change hard limits, classify its own risk, weaken
redaction, or decide whether a path is protected.

Permanent deny targets include the supervisor, rescue helper and corpus,
`AGENTS.md`, the fork's `FORK.md`, `.git`, credentials, sessions, models, and
generated output. Path checks use absolute containment, existing-parent
`realpath`, symlink refusal, and baseline hashes. No campaign performs a
commit, push, reset, clean, or broad checkout restoration; the fork's `origin`
remains upstream and is never a promotion target.

### Ordinary task loop

For each non-command task, a fresh read-only child either classifies it trivial
or submits a structured acceptance contract. Material ambiguity permits two
question-only turns, up to three focused questions each; mutation tools are
denied until the answer arrives. A best-effort contract then freezes with
visible assumptions. The worker sees the public claims and up to five active
lessons within 4,000 characters, while private rubric details stay in the
evaluator child.

At turn stopping, one new read-only evaluator judges every claim against
redacted authoritative session/tool evidence. Mechanical failure overrides a
semantic pass. A passing result stops immediately; a repairable failure steers
at most two same-turn corrections. Repeated failure fingerprints and A-B
oscillation stop early. Ordinary evaluator infrastructure fails open as an
`unverified` episode, but never activates a lesson. A queued replacement after
user cancellation marks the prior contract `superseded`, which gives
`/redirect` the required new-contract behavior.

The evaluator also returns reflection plus up to three lesson and backlog
candidates. Exact lesson fingerprints merge; two independent verified sessions
activate a candidate, while one contradictory verified episode quarantines an
active lesson. One verified episode plus `/refine lesson approve <id>` is the
human shortcut. Absolute paths, local symbols/configuration, user data, machine
identifiers, and credential-shaped text force project scope. Retrieval is
deterministic and tracks exposure/outcome association without claiming
causality. Candidates retire only after both 90 days and 100 later nontrivial
opportunities; active, pinned, and hand-approved lessons do not age out.

The local Qwen profile produces about 10–12 tokens/s at xhigh reasoning. The
supervisor therefore inherits the profile's normal 32,768-token allowance and
uses a 60-minute child/worker timeout; there is no smaller learning-only token
cap. The llama server already preallocates the 200k quantized cache and memory
maps model data into system RAM, so allowing a longer generation does not make
VRAM grow without bound.

### `/refine` operations

| Command | Effect |
|---|---|
| `/refine [focus]` | Select one explicit or ranked open objective; run a bounded reviewed campaign |
| `/refine status [id]` | Show versions, counts, state, exact targets, dependencies, validation gaps, and restart needs |
| `/refine apply <id>` | Revalidate and promote an explicitly approved risky candidate |
| `/refine rollback [id|last]` | Restore exact snapshots only while promoted hashes still match |
| `/refine pause` / `/refine resume` | Disable/re-enable contracts, retrieval, evaluation, and new campaigns without deleting state |
| `/refine lesson approve <id>` | Activate one verified candidate and protect it from automatic retirement |
| `/refine lesson reject <id> <reason>` | Quarantine a candidate/lesson as contradicted |
| `/refine lesson pin <id>` | Protect a lesson from automated grooming |

Campaigns stage under `%USERPROFILE%\.dsh\learning\refine\<campaign-id>`,
outside both repositories. Workers can read approved roots and stage replacement
bytes through custom tools, but cannot write repositories or run commands.
Manifests are capped at 20 files and 2,000 changed lines, hash-checked, and
reviewed by deterministic validators, the hidden corpus, and a fresh evaluator;
two fresh repair candidates are the maximum. Checkpoints are append-only.

Only lesson operations, declarative policy, and
`plugins/learning/mutable/**` can activate from the first command. Everything
else becomes `needs_approval`. Harness candidates additionally require a clean
`delete-session` branch at the exact staged HEAD, a detached temporary
worktree, focused package tests, typecheck, and build. Cross-cutting core,
manifest, dependency, or configuration changes run the full suite. Dependency
proposals must be exact versions, install offline with scripts disabled, and
are rejected in v1 when the resolved package has lifecycle scripts or native
binary markers.

Risky promotion writes exact backups first, re-runs validators in the real
target, and restores immediately on failure. Executable changes remain
`waiting_restart`. `run-dsh.ps1` (deployment-only changes) and
`run-dsh-fork.ps1` (any Harness source change) arm the protected rescue helper before launch;
the campaign becomes `absorbed` only after the entire loader tree is active,
the WebServer exposes a listening port, the hidden self-check passes, and the
matching source hashes are written to the heartbeat. Exit, timeout, hash
mismatch, or failed canary restores exact bytes, rebuilds prior Harness source
when necessary, relaunches once, and records `rolled_back`.

## Local `/redirect` interrupt-and-steer command

The deployment registers `plugins/command-redirect.mjs` from
`deepseek-harness.yml` as an absolute Windows file URL:

```yaml
- insert:
    - id: command-redirect
      name: 'file:///E:/Qwen3.8_27b/plugins/command-redirect.mjs'
```

Use `/redirect <instruction>` only while an agent reports `running`. The
handler trims the argument, rejects empty input, and creates the user-sourced
replacement message *before* aborting anything. It then performs:

```js
agent.cancel({ kind: 'user' })
agent.steer(message)
```

Omitting `keepInbox` is deliberate: `cancel()` clears queued user and steering
work. Because cancellation has already aborted the driver, the following
`steer()` is classified by the existing agent loop as a latched next-turn wake;
it runs after cancellation converges. `recordInput: false` prevents the slash
command itself from being recorded as a duplicate user input—the replacement
message is logged by the inbox and subsequent `user/message` path.

### Interface and limits

- Text only; slash-command arguments do not carry attachments.
- Empty input returns `Redirect instructions are required. Usage: /redirect
  <instruction>` without cancelling anything.
- Idle use returns `No task is running. Use a normal message instead.`
- Success immediately returns `Current task interrupted; redirect queued.`; it
  does not wait for the replacement task to finish.
- Cancellation is cooperative. A provider or tool that delays observing its
  abort signal also delays the replacement turn.
- Completed or already-started external side effects are not rolled back.
- Repeated redirects during convergence have replace-all semantics: each
  invocation clears pending inbox work, so the latest replacement wins.
- No public TypeScript interface, event type, RPC, UI, or wire schema changed.

### Queueing a follow-up during a running turn

Two Web-UI mechanics that a live `/redirect` pass runs into immediately, both upstream
behavior rather than deployment quirks:

- **An ordinary session that is running has no Send button.** `InputBar.tsx` computes
  `primaryStops = running && subagent === null`, so the primary composer control is Stop,
  and the only way to queue a follow-up by pointer-and-keyboard is **Enter**. Continuable
  child sessions keep Send as the primary and expose Stop separately, which is why a
  subagent view looks different. Enter while busy resolves through
  `ComposerSubmissionPolicy.resolve`, which delivers `queue` or `steer` per the durable
  busy-Enter preference.
- **A bare `/redirect` needs two Enters.** The first is consumed by the command menu's
  arbitration to complete the token (leaving `"/redirect "` in the draft); the second
  submits it. A `/redirect <args>` line submits on one Enter because the menu is already
  closed by then.

### Verification (2026-08-19)

Unit and boot-level verification is in the full-mode rollout and acceptance record below.
The live browser acceptance pass (DSH-05) is in `change_log.md` under the `/redirect`
entry: original turn ends `aborted`/`user`, the queued follow-up is spliced out with
`outcome: "canceled"`, only the redirect starts as turn 2, and both error paths produce
command rows with no model turn.

## Full-mode rollout and acceptance — 2026-08-19

The staged rollout finished on 2026-08-19. `deepseek-harness.yml` now carries
`mode: full`; the earlier `observe` and `lessons` gates remain available for
triage.

### Runtime as accepted

- The harness runs from the built fork CLI via `run-dsh-fork.ps1`, serving
  `http://127.0.0.1:3080/` with the process working directory at
  `E:\Qwen3.8_27b`, so the sandbox `workspaceRoot` stays the project.
- Protected heartbeat at generation 9: `profile=web`, `selfCheck=true`,
  `campaignId=null`, and `runtimeBin=E:\deepseek-harness\apps\cli\lib\bin.js`.
  Its `supervisor` and `engine` SHA-256 values, and the storage domain's
  `activePolicyVersion`, match `sha256sum` of the three on-disk files exactly:

  | File | SHA-256 |
  |---|---|
  | `plugins/learning-supervisor.mjs` | `520d5a46aa65b88a...ef2949ba` |
  | `plugins/learning/mutable/engine.mjs` | `596b6bcda8872f33...7d31b3e0` |
  | `plugins/learning/mutable/policy.json` | `00bfa0cbd31e92b6...11680a05` |

- The storage domain reports `mode: full`, `paused: false`, `schemaVersion: 1`.

### Second independent recurrence run — result

The evaluator that was mid-flight at handoff completed. Session
`session-b13f7740-b1e7-4e1f-80eb-a71da8cce37b` produced episode
`75dd806b-6a2d-4896-b76b-d8e9724e0016`, terminal outcome **pass**, one attempt,
no error classes, eight evidence references. It contributed three further
candidate lessons (`54de5491`, `816c3efd`, `c42fc353`) and three backlog items.

**No lesson reached recurrence 2 automatically.** All six candidates sit at
`recurrence: 1`. The reason is the designed one, not a defect: the two lessons
describing the same sandbox `spawn EPERM` finding — `9c16e004` from the first
session and `816c3efd` from the second — carry different fingerprints because
the first was forced to `project` scope by an absolute path in its text while
the second is `global`. Exact fingerprints merge deterministically; semantic
near-duplicates are left for `/refine` by design.

The frozen contract's known factual defect (it claimed 10 lines for a 9-line
file) did not cause a failure: the worker disclosed the discrepancy, and the
evaluator judged the product outcome against the rest of the contract. The
episode also shows the design working in the other direction — one of the
lessons it generated, `54de5491`, is precisely about quoting a reader's line
count instead of counting by hand.

### Live command-surface acceptance

Run against the real Web client at `127.0.0.1:3080`. Results are the server's
own `commands/execute` responses.

| Command | Result |
|---|---|
| `/refine status` (lessons mode) | `Learning active; mode lessons`, revision 11, candidate 6 / active 0 |
| `/refine pause` | `Learning paused. Contracts, retrieval, evaluation, and new campaigns are disabled; state was retained.` |
| `/refine status` | `Learning paused; mode lessons`, revision 12 |
| `/refine resume` | `Learning resumed in lessons mode.` |
| `/refine lesson approve 816c3efd...` | `is active and protected from automatic retirement`; storage confirms `status: active`, `handApproved: true` |
| `/refine` (lessons mode) | `Refinement is unavailable in lessons mode; status, pause, resume, and lesson review remain available.` |

That last row matters for sequencing: `refine()` returns early unless
`settings().mode === 'full'`, so a campaign cannot be exercised before the mode
switch. The original handoff checklist put the campaign ahead of full mode;
that order is impossible and was corrected.

### Deployment checks

| Check | Result |
|---|---|
| `node --check` on supervisor and engine | both clean |
| `node --test` supervisor + engine suites | **35 passed, 0 failed** |
| PowerShell parser on `learning-rescue.ps1`, `run-dsh.ps1`, `run-dsh-fork.ps1`, `run-all.ps1` | all parse |
| Fork CLI `--profile web --patch ... --dump-config` | exit 0; `learning-supervisor` present with `mode: full` |

The two live-only fixture files under `plugins/learning/mutable/` were deleted
after the evaluator finished. Nothing referenced them, and the engine hash
covers only `engine.mjs`, so removing them moves no version.

### Fork integration checks

`E:\deepseek-harness` was clean and on `delete-session` before and after; no
fork source was changed, and nothing was committed, reset, cleaned, or pushed.

| Check | Result |
|---|---|
| `corepack pnpm run typecheck` | exit 0 |
| `corepack pnpm run test` (full suite) | 12,883 passed, 42 failed, 62 skipped |
| `corepack pnpm run build` | `build:lib` succeeded; `build:web` failed on a PATH issue, below |
| `corepack pnpm --filter @deepseek-ai/dsh-web-frontend run build` | exit 0 |

`build:web` is written as `pnpm --filter ... run build`. Invoked through
`corepack pnpm run build`, that nested call resolves a bare `pnpm` that is not
on this machine's PATH and dies with "'pnpm' is not recognized". Running the
same filter through `corepack` completes it. Nothing in the repository is
wrong; the machine simply has no `pnpm` shim installed, and `corepack enable`
would fix it globally if that is ever wanted.

Of the 42 test failures, 41 are environmental and 1 is real:

- **32** fail with `EPERM: operation not permitted, symlink`. This account
  lacks `SeCreateSymbolicLinkPrivilege`, so every test that plants a symlink
  fails before it reaches an assertion.
- **6** in `sandbox-windows-acl` fail with `CreateProcessAsUserW failed
  (Win32 2)` — PowerShell 7 (`pwsh`) is not installed; only Windows PowerShell
  5.1 is. **1** more in `pwsh-sandbox` fails for the same reason, asserting the
  resolved path matches `/pwsh(\.exe)?$/`.
- **1** in `subagent-claude-code/real-product.spec.ts` times out in a hook; it
  drives the real Claude Agent SDK.
- **1** in `scripts/oxlint-contract.spec.ts` times out at 20 s.
- **1 is genuine and pre-existing**: `typert/generator/tests/cordis-catalog.spec.ts`
  asserts every committed catalog artifact reproduces byte for byte, and it
  does not. Adding `delete()` and `supportsDeletion` to the session-persistence
  seam on 2026-08-18 changed the generated cordis surface, but the committed
  artifact under `docs/subsystems/` was never regenerated — it contains no
  mention of either, and the last commit touching that directory is an upstream
  merge rather than `5437c65bec`. Tracked in `tasks.md`; the fix is
  `corepack pnpm run gen-cordis-catalog` plus a commit, and it would block an
  upstream contribution until done.

### Defects found during rollout

Both are recorded in `tasks.md` with reproduction detail.

1. **An interrupted campaign is never reconciled.** ~~`reconcileRescueReceipts`
   only re-states campaigns that left a `rolled-back-*.json` receipt.~~ **Fixed
   in DSH-01.** `initialize()` now also calls `sweepInterruptedCampaigns()`,
   which moves every campaign left in `collecting`, `staged`, `validating`,
   `ready`, or `promoting` to `abandoned` with `sweptAtBoot` set and a
   checkpoint naming the state it died in. `waiting_restart` and
   `needs_approval` are exempt — both are legitimately cross-boot, absorbed by
   `markBootReady` and resumed by `/refine apply` respectively.
   `selectRefinementObjective` skips swept campaigns when deciding suppression,
   so a swept objective becomes selectable again without new evidence; a
   campaign that reached `abandoned` on its own merits still suppresses.
   Campaign `bcecaf0c-c0e9-4e90-b6de-8c73acbb4857` was the fixture and read
   `abandoned` on boot generation 10.

2. **The Web client will not open a session whose first message is a slash
   command.** `session.create` and `commands/execute` both return 200 and the
   command genuinely executes, but the client keeps rendering the New Session
   draft panel, so the command's result row is never shown and the stop control
   is unreachable. That is what made the mistaken campaign above impossible to
   cancel from the UI; it had to be killed by restarting the harness. Not
   caused by the learning plugin — any command behaves this way.
   **Not a defect — deliberate upstream design.** Investigated and closed as
   documented behavior in DSH-03; the mechanism is below.

### A command-only session stays on the hero, by design (DSH-03)

Two predicates in the upstream client agree that a slash command is
control-plane traffic and does not start a conversation. Both live in files the
fork has **never** touched — `git diff dsh-v0.1.0-rc.7` over
`packages/client/runtime/src/client/sessions/session.ts` and all of
`packages/client/ui-conversation/` is empty — so this is upstream behavior, not
a fork regression.

| Site | Rule |
|---|---|
| `runtime/src/client/sessions/session.ts:788` | `hasVisibleConversationContent()` counts a chat node only when `kind !== 'command'`. Its comment: *"A generic command row alone remains control-plane content; every other visible Chat Node activates the conversation."* |
| `runtime/src/client/sessions/session.ts:248` | The blank bit flips on an **accepted prompt**, never on a command: *"standalone command and projection events never flip it."* |

So a session whose only content is command rows keeps `composerPhase === 'blank'`
and `blank === true`, which the view layer reads twice:

- `ui-conversation/.../skeleton/ConversationRoot.tsx:80` — `hero = composerPhase === 'blank' && (openState === 'open' || summaryBlank === true)`, so the New Session hero renders instead of the docked composer.
- `ui-conversation/.../skeleton/ConversationSession.tsx:165` — `if (blank && composerPhase === 'blank') return null`, so the row area is not rendered at all. This is why the result row is invisible and the stop control unreachable, rather than merely mis-styled.

The intent is sound for quick control-plane commands — `/permission`, `/model`,
`/plan`, `/compact` should not evict a user from the welcome hero. The
consequence upstream did not weigh is a **long-running** command: `/refine`
started as a first message has no visible row and no cancel affordance.

**Workaround, and the standing rule here:** start the session with an ordinary
message, then send the command. One prompt is enough to flip the blank bit
permanently (the mirror only ever lowers), and every later command in that
session renders and cancels normally.

The rejected fixes, for the record. Making `hasVisibleConversationContent`
count command nodes is close to a one-line change, but it inverts the upstream
rule for *every* command on a blank session and pulls two new files — one of
them `session.ts`, a rebase-conflict magnet — into a fork diff that is
otherwise only the session-deletion seam. Classifying commands as
cancellable-vs-quick would honor the intent, but no such classification exists
to key off. Neither is worth widening a fork whose stated direction is to be
upstreamed and dropped.

### First `/refine` campaign, end to end — 2026-08-19

Campaign `64ff4138-12f9-4f7f-9b8c-87f33130acf8`, the first real `/refine` run under
`mode: full`. It reached the terminal state **`abandoned`** after 27m13s. The gate
behaved correctly; the local model did not finish.

**Selection.** Drawn from backlog item `f1f2174f-63ec-489b-823b-06526b161ecb`,
"Have session tool events record the explicit exit code of executed commands so
evaluators need not infer it from runner output", at `evidenceCount: 8`. Objective
fingerprint `58df82f26dd8363c6d51b6e10e7e0a15347399152ceeeeaf80bfbed78687798e`.

**Frozen contract.** Three acceptance claims, four non-goals, both repo roots as
`permittedRoots`, the full `SUPERVISOR_LIMITS`, and a git baseline of both checkouts —
W at `d83ae87` (dirty, pre-commit), F clean on `delete-session` at `26f3d16`, storage
revision 15. `parentRevision` `26f3d168ba5101a70e4ed174ed39c19347ddd2a0`.

**Terminal record.**

| Field | Value |
|---|---|
| `state` | `abandoned` |
| `riskClass` | `low` (initial; never re-derived — nothing was staged) |
| `patchManifest` | `{}` — empty |
| `targetFiles` | `[]` — empty |
| `hashes` / `promotedHashes` | `{}` / `{}` — empty |
| `evaluator` | `{}` — never reached |
| `validators` | one entry: `{ name: "worker", ok: false, detail: "learning refinement worker ended without valid structured output" }` |
| `repairCount` | 0 |
| `failureFingerprints` | `[]` |
| `restartGeneration` | 0 |
| Checkpoints | `checkpoint-000-collecting.json` (15:44:50), `checkpoint-001-abandoned.json` (16:12:03, note `Refinement worker failed closed`) |

Everything downstream of the worker is empty because the campaign never left
`collecting`. There is no patch, no staged file, no hash, and no evaluator verdict to
record — that absence *is* the result.

**Root cause: the worker hit the output-token ceiling, not a timeout.** The refinement
worker ran as child session `5a817370-c217-4b48-b8e7-d996c778c4c2` (`subagent/descriptor`
= `{ mode: "one-shot", provider: "learning-supervisor", label: "learning refinement
worker" }`) against `local-qwen` / `qwen3.8-27b`, `maxTokens: 32768`,
`reasoningEffort: medium`, `contextWindow: 200000`. Over 61 steps it made 75 tool calls
— 41 `learning_list`, 34 `learning_read`, all read-only exploration of the fork — and
emitted roughly 754k characters of reasoning across 5,584 reasoning chunks against 26
text chunks. It never called `learning_submit` or `learning_stage`.

The final step's usage reads `inputTokens: 3483, outputTokens: 32768,
cacheReadTokens: 156267` — output exactly at the configured cap — and the turn closed
with `turn/end reason.kind = "max-tokens"`. Context was the non-binding limit at ~160k
of 200k; the model was cut off mid-deliberation, having just converged on an approach
("Approach 2 is low-risk") but before it could submit anything.

`captureStructured` therefore saw `captured === undefined` and threw
(`plugins/learning-supervisor.mjs:756`); the campaign loop caught it and moved the
campaign straight to `abandoned` (`plugins/learning-supervisor.mjs:1718`).

**What this proves and what it does not.** It proves the fail-closed path: a worker that
produces no valid structured output cannot stage, cannot promote, and lands in a terminal
state on its own, leaving both checkouts untouched. It does **not** exercise the risk
classifier, the validators, the evaluator, or the `needs_approval` gate — none of those
were reached. Those remain covered only by unit tests.

**Two design observations, neither fixed here.**

1. `refinementRepairCycles: 2` does not apply to worker failure. The loop at
   `plugins/learning-supervisor.mjs:1714` catches a worker exception and `return`s
   immediately; repair generations only cover validation failures. A single
   token-exhausted step consumes the whole campaign with zero retries.
2. This failure is distinct from the one DSH-01 describes. DSH-01 is about a campaign
   whose *process dies* leaving no receipt and no terminal state; here the process lived,
   failed closed, and reconciled itself correctly. Both end in a stranded objective
   fingerprint, but only one is a reconciliation gap.

## Why a fork was necessary

The harness runs from npm (`@deepseek-ai/dsh@0.1.0-rc.7` via `npx`), which
publishes **build output only** — `lib/*.js` plus `lib/types/*.d.ts`, and one
minified frontend bundle. No `dsh-*` package ships a `src/` directory, and no
build tooling is included.

Session deletion did not exist anywhere in that stack:

- `SessionPersistence` (the seam) declares `create/append/load/inspect/readFrom/list/listSnapshots/locate` — no delete.
- `SessionStore` (`ctx.sessions`) is in-memory only; it has `fork`, no delete.
- The client `ISessions` interface has `open/fork/search/clear/…`, and its own
  docstring calls widening it a deliberate act.
- The shipped frontend bundle contains exactly two session RPCs: `sessions.list`
  and `sessions.provideInfo`.
- `workspace.delete` removes only a Workspace *registration* — its docs state
  every session log is kept.
- Archive hides a row via a registry-global archive set and never touches disk.

Upstream's own position is that pruning is external: the jsonl backend README
says nothing deletes session files, and the projection-cache README calls
pruning "out-of-band maintenance."

Extending it out-of-tree was possible for a *command* (`ctx.commands`), but not
for a *button*: that needs the client `ISessions` interface, a wire method, and
the Typert-generated contract, none of which can be produced without source.

## Session storage (independent of the harness install)

```
%USERPROFILE%\.dsh\sessions\--<normalized-cwd>--\<session-id>\session.jsonl.zstd
```

One directory per session. This is why sessions already survive harness updates:
they live in `~/.dsh`, while the npm package lives in
`%LOCALAPPDATA%\npm-cache\_npx\`. Those are unrelated directories — the npx
cache can be deleted entirely without touching a single log.

Two behaviors worth remembering:

- **Lazy materialization.** `create()` writes nothing; the file appears on first
  append. A session with zero turns leaves nothing on disk and is absent from
  `list()`.
- **Stale projection rows are normal.** `~/.dsh/storages/session_projcache.json`
  keeps a row per session with no eviction surface by design. Deleting a log
  leaves its row behind; the cache is documented as "never authority" and
  nothing reads a row whose log is gone.

Hand-deletion (`rm -rf` on the session directory, harness stopped) remains
valid and is what the button automates.

## What the feature added

Menu → wire → disk, mirroring `session.fork` at every layer.

| Layer | File(s) | Change |
|---|---|---|
| Seam | `packages/session/session-persistence/src/index.ts` | `supportsDeletion` + default-rejecting `delete()` |
| Backend | `packages/session/session-persistence-jsonl/src/index.ts` | real removal, `supportsDeletion = true` |
| Wire | `packages/host/apiproxy/src/{api-proxy,api/rpc-map,api/rpc,api/rpc.schema,api/sessions,api/sessions.schema,fetch/client,fetch/handler}.ts` | `session.delete` |
| Client | `packages/client/runtime/src/client/{contract/sessions,sessions/manager,sessions/service}.ts` | `ISessions.delete` |
| UI | `packages/client/ui-workspace/src/client/{rows/Rows.tsx,WorkspaceBrowser.tsx,contract/slots.ts,index.ts,locales.ts}` | menu entry + confirm dialog, en/zh |

### Deliberate design decisions

**`supportsDeletion` is a concrete `false`, not `abstract`.** An abstract member
would force every backend — sqlite and any third-party one — to implement it.
The concrete default keeps them compiling untouched and keeps the fork's diff
small. It mirrors the existing `supportsRawArtifacts`/`readRaw` pair in the same
file, which is the established precedent for an optional capability.

**Deleting a *running* session is refused, not auto-cleared.** A reversible
mistake beats an irreversible one, and it matches how `fork-unavailable` handles
bad state. The error surfaces inside the dialog, which stays open.

**Deletion is identity-validated.** The backend resolves the target through its
own `findLog` + `readPrefix` bound-identity check before removing anything —
never a raw path join. A symlinked session directory is `unlink`ed rather than
recursed through, ENOENT is tolerated, and the work is serialized in the
coordinator so a pending write-behind batch cannot resurrect the file.

**An unused upstream lint suppression was left in place.** Adding `session.delete`
to `RpcMethodMap` gave `K` a second use in
`packages/host/apiproxy/src/fetch/handler.ts`, making its `oxlint-disable`
redundant. Lefthook warns about it on every commit. Deleting an upstream line to
silence a warning is not worth the rebase conflict.

## The two defects end-to-end testing found

Both passed the entire unit suite — typecheck 0, and 123 ui-workspace + 51
apiproxy + 137 persistence + 45 client-runtime tests green — while the button
was completely non-functional. Fixed in `f57dd99bba`.

**1. `cannot get property "sessionPersistence" without inject`.** The
implementation read the seam as a bare `ctx.sessionPersistence` property. Cordis
rejects property access on an undeclared injection, so every delete that got
past the liveness guard threw at runtime. The fix uses
`ctx.get('sessionPersistence')` — the optional accessor the same file already
uses for its other persistence reads. Adding the seam to the service's `inject`
array was the wrong fix: it would make the whole api-proxy hard-require
persistence and change boot behavior for surfaces that mount none.

**2. The liveness guard tested store residency, not busyness.** It refused any
session where `ctx.sessions.get(id) !== undefined`. But the list path hydrates
every served session into the store, so residency is true for idle rows — every
row the sidebar displayed was undeletable. The fix guards on
`ctx.agents.get(id)?.status === 'running'`, the same predicate the session
summaries and status frames already use (`api-proxy.ts` lines 1700, 2630, 3544).

### Why the tests did not catch either

They compose a **mocked cordis `Context`**, so the injection rule never applied
and `ctx.sessions` was empty. Worse, the refusal test asserted the second bug as
intended behavior (`refuses an attached session`) — the suite did not merely
miss the defect, it ratified it. That test now covers a *running* session, and
two regression tests were added for exactly what the mocks hid: deleting a
store-resident idle session succeeds, and a context with no persistence mounted
reports `session-delete-unsupported` rather than throwing.

**Standing lesson: a green suite is not evidence this feature works.** After any
change or rebase, start the harness and delete a throwaway session through the
UI.

## Launcher design

`run-dsh-fork.ps1` runs `E:\deepseek-harness\apps\cli\lib\bin.js` by absolute
path with plain `node` — no `tsx` loader resolution, because `pnpm run build`
has to run anyway for the browser bundle and it emits a plain-node bin.

The subtle part: **the harness derives its sandbox `workspaceRoot` and each new
session's cwd from `process.cwd()`**, and `deepseek-harness.yml` pins
`workspaceRoot: !!js process.cwd()`. Running `pnpm dsh` from inside the checkout
would silently re-root the model's write sandbox at the harness source tree.
Invoking the built bin by absolute path keeps the working directory ambient — it
stays the project — which is why the launcher also prints the effective
workspace on startup.

The customized fork is the deployment default as of DSH-08: `run-all.bat`
selects `run-dsh-fork.ps1`. The published package remains an explicit fallback
through `run-all-published.bat` or `run-all.ps1 -Published`; `run-dsh.ps1` pins
`@deepseek-ai/dsh@0.1.0-rc.8`. `run-all-fork.bat` remains an explicit alias for
the default fork path.

## Verified behavior (2026-08-18, against a live harness)

| Case | Result |
|---|---|
| Idle session | deleted; row removed without reload; directory gone from disk |
| Running session | refused; dialog stays open; error shown via `role="alert"` |
| No persistence backend mounted | clean `session-delete-unsupported`, no throw |

Known residual: deleting a session that is idle but still open removes its log
while the in-memory copy lingers for the life of the process. Typing into that
same open session afterward would start a fresh log.

## DSH-08 rc.8 acceptance (2026-08-19)

The fork is based on `dsh-v0.1.0-rc.8` (`141eb6fef8`) with rollback branch
`codex/delete-session-rc7-backup` at `bec6782544`. The Cordis catalog verified
byte-for-byte, typecheck and build exited 0, and the focused apiproxy,
session-persistence-jsonl, and ui-workspace run passed 753 tests across 33
files. The full suite passed 803 files and 13,508 tests; its 33 failures were
32 Windows symlink-privilege failures plus the known persistent-PowerShell
timeout, with no fork-attributable regression.

Deployment verification passed all 55 plugin tests, parsed all four
PowerShell launchers, loaded `deepseek-harness.yml` through the rc.8 CLI, and
matched every pre/post plugin and user-skill SHA-256. Live Web acceptance ran
`/doctor`, `/refine status`, `/ponytail-help`, and an in-flight `/redirect` that
reported `Current task interrupted; redirect queued.` The confirmed throwaway
top-level session `session-e8e5666e-3eae-4d7f-9a6f-3c964f395aae` was deleted
through the Web UI after restarting the harness to release its persistence
owner; its directory is gone.

The throwaway had spawned learning-contract child
`2a5e1545-f173-43cb-bcd3-ceb5e97a48eb`. Deleting the top-level session does not
cascade in the JSONL backend, so that hidden child artifact remains. It was not
deleted by hand because the acceptance path and DSH-06 policy require UI
deletion; the sidebar exposes no delete action for a detached subagent. Treat
descendant cleanup as a separate follow-up, not part of the rc.8 upgrade.

## Local development tooling topology (2026-08-20)

The authoritative live backlog is `E:\local-qwen-tracker`, a local Git repository with a
server-mode Dolt database and no Git or Dolt remote. W, F, and L use ignored
`.beads/redirect` files, so `bd ready --json` and `bd show` resolve the same issue graph
from every checkout. JSONL export is enabled for interoperability; it is not authority.

GitNexus indexes remain ignored and local. The `local-qwen` group maps W to `deployment`,
F to `harness`, and L to `inference/llama-cpp`. Serena remains the symbol/LSP tool; L uses
clangd with the generated CUDA `compile_commands.json`. None of these local analysis files
changes a collaborator-facing ignore file.

The llama.cpp development baseline is b10524 (`9ee9fc04c136`) in
`E:\llama.cpp\build-cuda-sm89`, configured for Release, CUDA 13.3, SM89, flash attention,
all-quant flash attention, native CPU tuning, and static backend linkage. The focused
`test-backend-ops` and `test-quantize-fns` CTest gate passes 2/2. GitNexus indexes the
CUDA-relevant surface after excluding two parser-pathological implementation units;
Serena/clangd covers those units directly and resolves `ggml_backend_cuda_init` across its
header, CUDA implementation, and callers.

Pinned profiler images are available without PATH mutation: Nsight Systems
2026.3.1.157 at
`C:\ns2631\ProgramFiles64Folder\NVIDIA Corporation\Nsight Systems 2026.3.1\target-windows-x64\nsys.exe`
and Nsight Compute 2026.2.1 at
`C:\Users\Joony\AppData\Local\Programs\NVIDIA Nsight Compute 2026.2.1\nsight_compute-windows-x86_64-2026.2.1.5-archive\nsight-compute\2026.2.1\target\windows-desktop-win7-x64\ncu.exe`.
Nsight Systems CPU sampling reports unavailable without Administrator privileges; Nsight
Compute reports `ERR_NVGPUCTRPERM` until GPU performance-counter access is enabled in the
NVIDIA Control Panel. CLI version checks and GPU discovery otherwise succeed.
