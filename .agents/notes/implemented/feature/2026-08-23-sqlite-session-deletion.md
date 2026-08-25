# Agent Note: SQLite Session Deletion

Status: implemented

English | [中文](2026-08-23-sqlite-session-deletion.zh.md)

## Problem

The SQLite persistence backend inherited `supportsDeletion = false` and reported deletion
as unsupported, while the JSONL backend already implemented the capability-gated
`delete()` contract. The host delete path (`session.delete`) therefore refused any
SQLite-backed session, and the seam documentation listed SQLite among the rejecting
backends.

## Decision

### Route through the coordinator, own only the row removal

`SessionPersistenceSqlite` sets `override readonly supportsDeletion = true` and implements
`delete(id, signal)` as a call to `coordinator.delete(id, remove, signal)`. All refusal
semantics — live session, pending persistence work — stay in the coordinator, identical to
JSONL. The backend contributes only `SqliteStore.remove(id, signal)`.

### One transaction, cascade does the fan-out

`remove()` runs `BEGIN IMMEDIATE` → `validateSchemaForMutation` → a single
`DELETE FROM sessions WHERE id = ?` (new `delete-session` SQL resource) → `COMMIT`,
rolling back through the store's existing `rollback(error, 'delete')` path. Event rows go
with the session row because `events.session_id` declares `ON DELETE CASCADE` and the
store's one memoized connection runs with `PRAGMA foreign_keys = ON`; the singleton
`persistence_state` row is untouched. Schema validation runs inside the transaction,
matching `appendBatch` and `commitRepair`.

### Descendants do not cascade

`sessions.parent_session` carries no foreign key. Deleting a parent leaves every
descendant's header, events, and `parentSession` value in place — the same non-cascading
policy the JSONL backend documents. An absent id is a successful no-op, matching the base
contract.

## Alternatives considered

**Explicit multi-statement delete of each table.** Two statements instead of one, and it
duplicates an invariant the schema already owns; the cascade is asserted through a second
connection in the spec rather than taken on faith.

**Extending `api-proxy-delete.spec.ts` with a SQLite case.** That spec imports the JSONL
backend directly and asserts on `SessionLocation` paths, which the SQLite backend does not
produce (`locate()` returns `undefined`); the API delete path never calls `locate()`, so
the coordinator seam tests already cover the shared behavior. Extending it is a rewrite,
not an added case.

**Cascading descendant deletion.** Would diverge from the JSONL backend's documented
policy and silently widen the blast radius of a single-session delete.

## Consequences

The host delete path now works for SQLite-backed sessions with unchanged refusal
semantics. Abort handling is shallow by construction: `remove()` observes the signal only
before the transaction opens, because the synchronous `node:sqlite` statements cannot be
interrupted mid-transaction — a partially deleted state is unreachable.

## Testing

`tests/sqlite-delete.spec.ts` (six tests): capability advertisement; idle delete removes
the session's rows, verified through a second raw connection; other sessions untouched;
absent id is a no-op; descendants survive a parent's deletion with rows and
`parentSession` intact; deletion while persistence work is pending is refused and the rows
survive. The in-flight-append refusal itself is coordinator-generic and covered in
`session-persistence`'s own suite.
