<!-- SYNCED COPY -- canonical file is E:\Qwen3.8_27b\change_log.md -->
> **Synced copy.** The canonical version of this file lives in
> `E:\Qwen3.8_27b\change_log.md`. Edit either one, then re-sync so they do not
> drift:
> ```sh
> cp E:/Qwen3.8_27b/{tasks,finished_tasks,change_log,details}.md E:/deepseek-harness/
> ```
> (re-add these banners after copying, or just accept the canonical text)

# Change log

Newest first. Technical background for every entry is in [details.md](details.md).

Two repositories are involved:

- **W** = `E:\Qwen3.8_27b` (this workspace, branch `main`)
- **F** = `E:\deepseek-harness` (harness fork, branch `delete-session`, base tag `dsh-v0.1.0-rc.7`)

---

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
