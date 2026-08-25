# Agent Note: Session Delete Bulk Selection and Running Refusal

Status: implemented

English | [中文](2026-08-20-session-delete-bulk-and-running-refusal.zh.md)

## Problem

The host refuses a running Session deletion with `session-delete-unavailable`. Relying only on that post-confirm refusal reveals the stop-first requirement after the operator commits, as an untranslated wire string.

Duplicate display titles make a name-only confirmation insufficient when several logs are removed together. There is no bulk `session.delete` RPC, and the tree already uses `aria-selected` for the current Session, so in-row multi-select would collide with click-to-open and drag.

Workspace registration deletion remains a different lifecycle: it removes only the Workspace record and never Session logs ([Workspace registration deletion](2026-07-27-workspace-registration-deletion.md)).

## Decision

### Single-session running refusal

The existing row-menu path is unchanged. The browser-owned confirmation renders from the current `SessionSummary.running` value and checks it again when Confirm is pressed. While that bit is true, the dialog states that the Session must stop first, Confirm is disabled, and `deleteSession` is not called. The host remains the TOCTOU authority if the agent starts after that client read.

### Bulk picker

A wide-header control opens a second `Modal` owned by `WorkspaceBrowser`. The picker lists every ordinary, non-archived, non-blank Session in host `session.list` order. Origin-subagent rows, archived ids, and blank New Session rows are omitted; a parent is not blocked because `runningSubagentCount` is nonzero. Each row shows the exact `displayTitle` and the opaque Session id. Running rows stay visible with a native `input type="checkbox"` that is disabled and the localized running status. Continue requires at least one checked idle Session and snapshots those title+id pairs into an irreversible confirmation. Search-result rows still have no delete control.

### Sequential confirm

Confirm calls the existing `deleteSession(sessionId)` once per snapshotted id, in snapshot order, awaiting each call. Immediately before each call the browser re-reads `running` and skips the RPC with the same stop-first copy when the Session is running. Successful ids leave the tree through the runtime's existing remove mutation. Per-target failures remain in the confirmation with `role="alert"` and the thrown `Error.message`; wire codes are not remapped and `SessionDeleteError` is not re-exported for this UI. Duplicate Confirm and close-while-pending are ignored. Partial success never drops failed survivors from the dialog.

## Alternatives considered

**In-tree checkboxes or modifier-click selection.** `aria-selected` already means the current Session, and row click opens the Session while drag reorders it. A separate header `Modal` keeps bulk identity checks off that row.

**A bulk `session.delete` RPC or `Promise.all`.** A new wire method would expand schema, host, and runtime without changing the per-id refusal rules. Parallel calls scramble order and partial outcomes. Sequential reuse of `deleteSession` keeps one code path.

**Stop-and-delete.** Cancelling a running agent as a side effect of Confirm would hide an irreversible log deletion behind an implicit stop. The operator stops the Session first; deletion is a separate confirmation.

**Mapping `SessionDeleteError` codes in the UI.** The runtime does not re-export that class on the client barrel, and workspace locale policy passes wire strings through. Preflighting `running` avoids parsing host messages for the expected busy case.

**Deleting from search rows.** Search rows have no action menu; adding delete there would invent a second entry beside the row menu and the header picker.

**Hiding running Sessions from the picker.** The operator would not see why a visible running row cannot be bulk-deleted. Disabled checkboxes plus localized running status keep those rows in the list.

## Consequences

- Bulk deletion is two dialogs (pick, then irreversible confirm); single deletion remains one confirmation from the row menu.
- A Session that starts between Continue and Confirm is skipped by the client preflight; a start in the gap after that read is still refused by the host.
- Archived Sessions still have no viewing or unarchive surface, and backends that do not set `supportsDeletion` still reject at the host.
- `runningSubagentCount` remains presentation-only; descendant activity does not refuse parent deletion.

## Testing

`packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx` covers running single-delete refusal, picker display of exact title and id, disabled running checkboxes, sequential multi-delete order, partial-failure survivor alerts, and a start-after-Continue confirm that does not call `deleteSession`. Host and runtime delete suites remain the authority for `session-delete-unavailable` and list mutation on success.
