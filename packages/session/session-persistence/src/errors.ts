/** Stable failures exposed by the session-persistence service. */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** The requested Session identity has no materialized durable log. */
export class SessionPersistenceNotFoundError extends Error {
  /** @param sessionId - absent durable Session identity. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" not found`)
    this.name = 'SessionPersistenceNotFoundError'
  }
}

/** Why a durable Session deletion was refused while a claim on the identity survives. */
export type SessionDeleteConflict =
  /** A live Session currently owns the identity; dispose it before deleting. */
  | 'live'
  /** A disposed lifecycle is still draining its buffered tail. */
  | 'retiring'
  /** A cold read for the identity is in flight. */
  | 'loading'
  /** An unpublished preparation is committing its durable repair. */
  | 'committing'
  /** An unpublished Session exclusively reserves the identity for resume. */
  | 'reserved'
  /** An outstanding lease is still borrowing the prepared source. */
  | 'borrowed'

/** A durable deletion was refused because the identity is still claimed. */
export class SessionDeleteConflictError extends Error {
  /**
   * @param sessionId - identity whose deletion was refused.
   * @param conflict - the surviving claim that blocked it.
   */
  constructor(readonly sessionId: SessionId, readonly conflict: SessionDeleteConflict) {
    super(`cannot delete session "${sessionId}": it is ${conflict}`)
    this.name = 'SessionDeleteConflictError'
  }
}
