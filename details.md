<!-- SYNCED COPY -- canonical file is E:\Qwen3.8_27b\details.md -->
> **Synced copy.** The canonical version of this file lives in
> `E:\Qwen3.8_27b\details.md`. Edit either one, then re-sync so they do not
> drift:
> ```sh
> cp E:/Qwen3.8_27b/{tasks,finished_tasks,change_log,details}.md E:/deepseek-harness/
> ```
> (re-add these banners after copying, or just accept the canonical text)

# Details — harness fork and session deletion

Durable technical reference for the local DeepSeek Harness fork. Written
2026-08-18. Companion files: [tasks.md](tasks.md),
[finished_tasks.md](finished_tasks.md), [change_log.md](change_log.md).

## Two repositories

| Path | Role | Branch | Remote |
|---|---|---|---|
| `E:\Qwen3.8_27b` | This workspace: llama.cpp server, launchers, harness config | `main` | none |
| `E:\deepseek-harness` | Fork of the harness itself | `delete-session` | `origin` = **upstream** deepseek-ai |

The fork's git contract lives in `E:\deepseek-harness\FORK.md`, and its
`AGENTS.md` carries a banner pointing there. Short version: never push, never
commit on `master`, base tag is `dsh-v0.1.0-rc.7`.

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

The npx path (`run-dsh.ps1`, `run-all.bat`) is deliberately left as the default
and the fallback. `run-all.bat` forwards `%*`, and a double-click passes no
arguments, so it keeps using the pinned npm package; `run-all-fork.bat` is the
double-clickable fork path.

## Verified behavior (2026-08-18, against a live harness)

| Case | Result |
|---|---|
| Idle session | deleted; row removed without reload; directory gone from disk |
| Running session | refused; dialog stays open; error shown via `role="alert"` |
| No persistence backend mounted | clean `session-delete-unsupported`, no throw |

Known residual: deleting a session that is idle but still open removes its log
while the in-memory copy lingers for the life of the process. Typing into that
same open session afterward would start a fresh log.
