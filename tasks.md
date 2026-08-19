<!-- SYNCED COPY -- canonical file is E:\Qwen3.8_27b\tasks.md -->
> **Synced copy.** The canonical version of this file lives in
> `E:\Qwen3.8_27b\tasks.md`. Edit either one, then re-sync so they do not
> drift:
> ```sh
> cp E:/Qwen3.8_27b/{tasks,finished_tasks,change_log,details}.md E:/deepseek-harness/
> ```
> (re-add these banners after copying, or just accept the canonical text)

# Open tasks

Completed work is in [finished_tasks.md](finished_tasks.md). Background for
every item here is in [details.md](details.md).

Nothing below is blocking; the session delete button and local `/redirect`
command are implemented.

---

## Verification

- [ ] **Complete one live `/redirect` browser acceptance pass.** From a browser
      allowed to reach `http://127.0.0.1:3080`, start a long-running turn, queue
      a sacrificial follow-up, then submit `/redirect change direction`. Confirm
      the original turn is user-aborted, the follow-up is discarded, only the
      redirect starts next, and idle/empty invocations create error command
      rows without a model turn. Unit tests, config loading, real Web-profile
      boot, and the focused cancellation-convergence test already pass; the
      Codex in-app browser blocked localhost and prohibited a workaround.

## Housekeeping

- [ ] **Delete the stale blank session `session-43568c47`.** Left over from
      end-to-end testing: 0 turns, no title, lives under
      `~/.dsh/sessions/--E-qwenTest--/`. Good first use of the new button.

- [ ] **Decide whether stale projection-cache rows are worth pruning.**
      `~/.dsh/storages/session_projcache.json` still holds rows for sessions
      whose logs are gone. Harmless by design — the file is documented as
      "never authority" and has no eviction surface — so this is cosmetic.

- [ ] **Decide the default for `run-all.bat`.** It currently double-clicks into
      the pinned npm package (no delete button); `run-all-fork.bat` is the fork
      path. Flipping the default is a one-line change in `run-all.ps1`. Kept as
      is so a known-good fallback always exists.

## Fork maintenance

- [ ] **Rebase when a new upstream tag lands.** Upstream had exactly one tag
      (`dsh-v0.1.0-rc.7`) at fork time, so there is no cadence to judge yet.
      Procedure and expected conflict sites are in `E:\deepseek-harness\FORK.md`.
      Conflicts will concentrate in the api-proxy wire files and
      `packages/client/ui-workspace/src/client/rows/Rows.tsx`.

- [ ] **After any rebase, click the button before believing it.** Both defects
      found on 2026-08-18 passed the full unit suite. Start the harness, create
      a throwaway session, delete it, confirm the directory is gone.

## Possible follow-ups (not requested, not planned)

- [ ] **Multi-select / bulk delete.** Currently one session at a time.
- [ ] **Improve the running-session refusal.** The message says "stop it before
      deletion" but the dialog offers no way to do that. A "stop and delete"
      affordance, or disabling the menu entry while running, would be kinder
      than an error after confirmation.
- [ ] **Upstream contribution.** The seam addition is small, additive, and
      non-breaking; the feature is one upstream might want. Would eliminate the
      fork entirely. Needs a decision about whether to engage.
- [ ] **Session deletion for the sqlite backend.** It inherits
      `supportsDeletion = false` deliberately and reports unsupported. Only
      worth doing if that backend ever gets used here.
