<!-- SYNCED COPY -- canonical file is E:\Qwen3.8_27b\finished_tasks.md -->
> **Synced copy.** The canonical version of this file lives in
> `E:\Qwen3.8_27b\finished_tasks.md`. Edit either one, then re-sync so they do not
> drift:
> ```sh
> cp E:/Qwen3.8_27b/{tasks,finished_tasks,change_log,details}.md E:/deepseek-harness/
> ```
> (re-add these banners after copying, or just accept the canonical text)

# Finished tasks

Completed work, newest first. Commit hashes and per-change rationale are in
[change_log.md](change_log.md); technical depth is in [details.md](details.md).

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
