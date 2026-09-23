# Tasks

Tickets, not feature names. This document doubles as the delegation payload — scope,
acceptance criteria, constraints, decision bounds. One write, both purposes.

This file is still mandatory first-read context, but the authoritative live queue is now
the central Beads tracker at `E:\local-qwen-tracker`. Run `bd ready --json`, then
`bd show <id> --json`; use Beads for live status, dependencies, acceptance, and handoffs.
The ticket bodies below are retained as migration context, not as a competing queue.

**Status:** `TODO` · `WIP` · `DONE` · `BLOCKED`

Format, the BUILT commands, and the session workflow are in [CLAUDE.md](CLAUDE.md).
Shipped ticket bodies live in [finished_tasks.md](finished_tasks.md) — grep it, never read
it into context. Technical background for anything here is in [details.md](details.md).

**One ticket per session, then `/clear`.** Every ticket below is written so a cold session
can start from it with a single Read.

DSH-06 is preserved as Bead `lq-6kf` and blocked by blank-row affordance `lq-ctz`.
DSH-09 is Bead `lq-6y9`; code and automated tests have landed, and only its rate-limited
live Qwen replay remains.

---

## DSH-06 — Delete the blank session `session-723f9bb4`                [BLOCKED]

The delete button cannot reach a blank session, and the fix was declined on 2026-08-19 —
see Open decisions. Full evidence is in `change_log.md`.

### Objective
The leftover blank end-to-end test session is gone, deleted through the UI button rather
than by hand.

### Existing context
- **The original ticket named the wrong session.** It said `session-43568c47` was "0 turns,
  no title". That session has **3 turns and the title "hello"**, and its turn 3 is the
  conversation that specified the continual-learning loop. Do not delete it.
- The blank one is `session-723f9bb4-8b66-4816-9771-93382a217862` under
  `~/.dsh/sessions/--E-qwenTest--/` — 880 bytes, 8 events, no title, no turns. `session.list`
  reports `blank: true, turns: 0, title: null`.
- Its only content is a `/refine` status command run on 2026-08-19 15:36 — a second instance
  of the DSH-03 artifact.
- **Why it is blocked:** `rows/Rows.tsx:440` suppresses the whole row-actions menu when
  `row.blank`, and the fork's Delete item lives in that menu (`Rows.tsx:388`). `tree.ts:121`
  also hides blank rows unless current, and `tree.ts:126` excludes them from search. There is
  no UI path.

### Acceptance criteria
Session deleted from the sidebar menu; the directory is gone from disk. Unreachable today.

### Files allowed to change
None.

### Non-goals
Do not delete it by hand — the acceptance criterion is that the button works. Do not patch
`Rows.tsx` for this; that was considered and declined. Do not add bulk delete.

---

## Open decisions

Not tickets — questions that need an answer before they become one.

- **Upstream contribution for the session-delete seam.** The addition is small, additive,
  and non-breaking, and upstream may want it. It would eliminate the fork entirely, which
  also settles DSH-03's cost question. **No longer blocked** — DSH-02 landed on
  2026-08-19 and the fork's catalog test passes. Needs a decision about whether to engage
  at all. DSH-03 no longer bears on this: it closed without adding to the fork's diff, so
  the diff is still nothing but the session-deletion seam.
- **A cancel affordance for long-running commands on a blank session.** Fallout from
  DSH-03, which closed as documented upstream behavior: a command is control-plane content
  and does not activate the conversation, so a `/refine` sent as a first message has no
  visible row and no stop control. The workaround (ordinary message first) costs nothing,
  so this is only worth reopening as an **upstream issue**, never as a fork patch.
- **The default for `run-all.bat`.** DSH-08 switched it to the customized rc.8 fork so the
  deployed session-delete seam is present by default. `run-all-published.bat` and
  `run-all.ps1 -Published` preserve the pinned published-rc.8 fallback.
- **Stale projection-cache rows.** `~/.dsh/storages/session_projcache.json` holds rows for
  sessions whose logs are gone. Harmless by design — the file is documented as "never
  authority" and has no eviction surface — so this is cosmetic.
- **Delete is hidden on blank session rows.** `rows/Rows.tsx:440` suppresses the whole
  row-actions cell when `row.blank`, so the fork's Delete item never renders for an empty
  session — the one session type it is most useful on. Upstream's rule predates the item and
  is right for rename/fork/archive. **Declined 2026-08-19:** the fix is small but lands in
  `Rows.tsx`, a named rebase-conflict site, and would have to clear F's full suite to remove
  one 880-byte file. Revisit only if blank sessions start accumulating, or fold it into the
  upstream contribution if that ever happens. This is what keeps DSH-06 blocked.

- **Multi-select / bulk delete**, and a kinder running-session refusal. The current message
  says "stop it before deletion" but the dialog offers no way to do that; a "stop and
  delete" affordance, or disabling the menu entry while running, would beat an error after
  confirmation.
- ~~**Session deletion for the sqlite backend.**~~ Done under Bead lq-g4j (2026-08-23):
  `supportsDeletion = true`, transactional row removal via `coordinator.delete`,
  non-cascading descendants, focused tests in `sqlite-delete.spec.ts`.

---

## Fork maintenance

- **Rebase when a new upstream tag lands.** The fork is based on
  `dsh-v0.1.0-rc.8`; the rollback branch and rc.9 rebase procedure are in
  `E:\deepseek-harness\FORK.md`. Expected conflicts will concentrate
  in the api-proxy wire files and
  `packages/client/ui-workspace/src/client/rows/Rows.tsx`.
- **After any rebase, click the button before believing it.** Both defects found on
  2026-08-18 passed the full unit suite. Start the harness, create a throwaway session,
  delete it, confirm the directory is gone.

---

## Completed tickets

Bodies are in [finished_tasks.md](finished_tasks.md).

| Ticket | Landed |
|---|---|
| Customized local Harness upgraded to rc.8 and accepted end to end | 2026-08-19 |
| A refinement worker that dies without a manifest spends a repair generation; fail-closed preserved | 2026-08-19 |
| `/redirect` accepted live in the browser — turn aborted, queued follow-up discarded, only the redirect ran | 2026-08-19 |
| Command-first sessions stay on the hero by upstream design — documented, fork left untouched | 2026-08-19 |
| Fork cordis catalog regenerated for the session-deletion seam — real failure floor 42 → 41 | 2026-08-19 |
| Interrupted campaigns swept to `abandoned` at boot; swept ones stop suppressing their objective | 2026-08-19 |
| First `/refine` campaign observed end to end — `abandoned`, worker fail-closed | 2026-08-19 |
| Native continual learning and reviewed `/refine`, rolled out in `mode: full` | 2026-08-19 |
| Corepack shims installed so nested `pnpm` calls resolve — `corepack pnpm run build` exits 0 end to end | 2026-08-19 |
| Mode-gate ordering corrected: a `/refine` campaign cannot precede `mode: full` | 2026-08-19 |
| Local `/redirect` interrupt-and-steer command | 2026-08-19 |
| Session delete button for the harness Web UI | 2026-08-18 |
