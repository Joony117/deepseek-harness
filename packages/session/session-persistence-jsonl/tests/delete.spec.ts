/**
 * Durable session deletion and the resurrection fence.
 *
 * The deletion capability is additive at this release: the service face had no
 * deletion API at all. These cover the two halves of the fence that a naive
 * implementation gets wrong — an outstanding CLAIM on a prepared source must
 * block deletion, and a capability admitted BEFORE a deletion must never
 * republish the identity afterwards, while a FRESH create stays free to reuse
 * the id as a new incarnation.
 *
 * Revocation and admission are separate races and each needs its own case. The
 * deletion generation only advances once the backend has COMMITTED, so it
 * cannot speak for the window while the backend is still running; the
 * in-flight set covers exactly that window. And a session that reached the
 * fresh path is stamped nowhere else, so publication has to stamp it or a
 * disposed one reads as new again after its id is deleted.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionDeleteConflictError } from '@deepseek-ai/dsh-session-persistence'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** One mounted JSONL backend over a disposable root. */
async function mount(): Promise<{ ctx: Context; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-delete-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  cleanups.push(async () => {
    await fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { ctx, root }
}

/** Materialize one stored session with a complete turn. */
async function store(ctx: Context, id: string, events: SessionEvent[] = oneTurnLog()): Promise<SessionId> {
  const header = meta(id)
  await ctx.sessionPersistence.create(header)
  await ctx.sessionPersistence.append(header.id, events)
  return header.id
}

/** Publish an unpublished Session exactly as a real frontend does. */
function publish(ctx: Context, session: Session): () => void {
  const detach = ctx.sessions.enter(session)
  try {
    ctx.sessions.announce(session)
  } catch (error: unknown) {
    detach()
    throw error
  }
  return detach
}

async function storedIds(ctx: Context): Promise<string[]> {
  return (await ctx.sessionPersistence.list()).map(header => header.id)
}

/** Yield to the macrotask queue. */
function tick(ms = 2): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Delete once the lifecycle has finished releasing the identity. Disposal is
 * asynchronous, so `live`/`retiring` here is a timing state to wait out, not
 * the refusal under test — every other conflict still propagates.
 */
async function deleteWhenQuiet(ctx: Context, id: SessionId): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await ctx.sessionPersistence.delete(id)
      return
    } catch (error: unknown) {
      const transient = error instanceof SessionDeleteConflictError
        && (error.conflict === 'live' || error.conflict === 'retiring')
      if (!transient || attempt >= 100) throw error
      await tick()
    }
  }
}

/**
 * Hold the backend inside `deleteStored` so the pending-delete window can be
 * observed. The coordinator reads the hook off the backend instance when
 * `delete` is entered, so installing an own property before that call is what
 * it will run.
 * @returns `reached` resolves once the backend is inside the delete; `release`
 *   lets the real removal proceed.
 */
function holdBackendDelete(ctx: Context): { reached: Promise<void>; release: () => void } {
  const backend = ctx.sessionPersistence as unknown as {
    deleteStored: (id: SessionId, signal?: AbortSignal) => Promise<void>
  }
  const real = backend.deleteStored.bind(backend)
  let arrive!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => { arrive = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  backend.deleteStored = async (id, signal) => {
    arrive()
    await gate
    await real(id, signal)
  }
  return { reached, release }
}

describe('durable session deletion', () => {
  it('declares the capability and removes the stored artifact', async () => {
    const { ctx } = await mount()
    const id = await store(ctx, 'delete-me')
    expect(ctx.sessionPersistence.supportsDeletion).toBe(true)
    expect(await storedIds(ctx)).toContain(id)

    await ctx.sessionPersistence.delete(id)

    expect(await storedIds(ctx)).not.toContain(id)
    await expect(ctx.sessionPersistence.load(id)).rejects.toThrow()
  })

  it('treats absence as the postcondition, so a retried delete succeeds', async () => {
    const { ctx } = await mount()
    const id = await store(ctx, 'delete-twice')

    await ctx.sessionPersistence.delete(id)
    // The second call has nothing to remove and must still resolve: a caller
    // recovering a partially-applied delete has to be able to reach a clean end.
    await expect(ctx.sessionPersistence.delete(id)).resolves.toBeUndefined()
    await expect(ctx.sessionPersistence.delete(SessionId('never-existed'))).resolves.toBeUndefined()
  })

  it('refuses while a live Session owns the identity', async () => {
    const { ctx } = await mount()
    const id = await store(ctx, 'live-owner')
    using preparation = await ctx.sessionPersistence.prepare(id)
    const detach = publish(ctx, preparation.session)

    await expect(ctx.sessionPersistence.delete(id)).rejects.toThrow(SessionDeleteConflictError)
    // Refusing is not enough: the log must survive the refusal.
    expect(await storedIds(ctx)).toContain(id)

    detach()
  })

  it('refuses while a borrow lease is outstanding, and allows it once released', async () => {
    const { ctx } = await mount()
    const id = await store(ctx, 'borrowed')

    const borrowed = await ctx.sessionPersistence.borrowSession(id)
    const refusal = await ctx.sessionPersistence.delete(id).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(SessionDeleteConflictError)
    expect((refusal as SessionDeleteConflictError).conflict).toBe('borrowed')
    expect(await storedIds(ctx)).toContain(id)

    // Releasing the lease leaves a merely CACHED ready source behind. A cache
    // entry is not a claim, so deletion must now succeed — a guard written on
    // `has(id)` would keep refusing here forever.
    borrowed[Symbol.dispose]()
    await expect(ctx.sessionPersistence.delete(id)).resolves.toBeUndefined()
    expect(await storedIds(ctx)).not.toContain(id)
  })

  it('vetoes publication of a source prepared before the deletion', async () => {
    const { ctx } = await mount()
    const id = await store(ctx, 'stale-capability')

    // Borrow, retain the exact prepared Session, then release the lease so the
    // delete is permitted. This is the real resurrection shape: the holder is
    // now invisible to the preparation pool.
    const borrowed = await ctx.sessionPersistence.borrowSession(id)
    expect(borrowed.source).toBe('prepared')
    const stale = borrowed.source === 'prepared' ? borrowed.preparedSession : undefined
    expect(stale).toBeDefined()
    borrowed[Symbol.dispose]()

    await ctx.sessionPersistence.delete(id)

    // Publishing must be refused SYNCHRONOUSLY. An async rejection would be too
    // late: rc.1 logs a rejected creation listener without rolling publication
    // back, so the session would already be live over a deleted log.
    expect(() => publish(ctx, stale as Session)).toThrow(/deleted/)
    // And the veto must not have recreated the artifact on the way out.
    expect(await storedIds(ctx)).not.toContain(id)
    // Refusing is only half of it: the paired detach has to roll the store
    // entry back too, or the session is live in memory over a deleted log.
    expect(ctx.sessions.get(id)).toBeUndefined()
  })

  it('refuses publication while the backend delete is still running', async () => {
    const { ctx } = await mount()
    const id = await store(ctx, 'delete-in-flight')

    const borrowed = await ctx.sessionPersistence.borrowSession(id)
    const stale = borrowed.source === 'prepared' ? borrowed.preparedSession : undefined
    expect(stale).toBeDefined()
    borrowed[Symbol.dispose]()

    // Make the holder POOL-INVISIBLE, which is the shape that actually needs
    // this guard. A durable append discards the prepared view, so `stale` is no
    // longer any entry's session: `reservationFor` returns undefined instead of
    // refusing, and publication falls through to the fresh branch. While the
    // ready entry survives, an unrelated refusal masks the race and the test
    // would pass with the guard removed.
    await ctx.sessionPersistence.append(id, [
      { type: 'turn/start', seq: SessionSeq(oneTurnLog().length), time: 7, data: { turn: 2 } },
    ])

    // The generation is the WRONG instrument here and this is the case that
    // shows it: it advances only after the backend commits, so throughout this
    // window the stale capability still matches the current generation.
    const { reached, release } = holdBackendDelete(ctx)
    const pending = ctx.sessionPersistence.delete(id)
    await reached

    expect(() => publish(ctx, stale as Session)).toThrow(/being deleted/)
    expect(ctx.sessions.get(id)).toBeUndefined()

    release()
    await pending
    expect(await storedIds(ctx)).not.toContain(id)
  })

  it('refuses to republish a fresh session that was disposed before the delete', async () => {
    const { ctx } = await mount()
    const id = SessionId('fresh-then-deleted')

    // Never prepared by the coordinator: this session takes the fresh path, so
    // publication is the only place it is ever stamped.
    const fresh = ctx.sessions.prepare(id)
    const detach = publish(ctx, fresh)
    await ctx.sessionPersistence.ensureMaterialized(fresh)
    expect(await storedIds(ctx)).toContain(id)

    detach()
    await deleteWhenQuiet(ctx, id)
    expect(await storedIds(ctx)).not.toContain(id)

    // The object outlived its lifecycle. Republishing it must not read as a
    // brand-new session and re-persist the old seed under a deleted identity.
    expect(() => publish(ctx, fresh)).toThrow(/deleted/)
    expect(await storedIds(ctx)).not.toContain(id)
    expect(ctx.sessions.get(id)).toBeUndefined()
  })

  it('lets a fresh explicit create reuse a deleted id', async () => {
    const { ctx } = await mount()
    const id = await store(ctx, 'reusable-id')
    await ctx.sessionPersistence.delete(id)

    // Deletion retires ONE incarnation, not the name. Permanently retiring ids
    // would be a different product decision, not a consequence of this fence.
    const header = meta(id)
    await ctx.sessionPersistence.create(header)
    await ctx.sessionPersistence.append(id, oneTurnLog())

    expect(await storedIds(ctx)).toContain(id)
    const reloaded = await ctx.sessionPersistence.load(id)
    expect(reloaded.events.length).toBe(oneTurnLog().length)
    expect(reloaded.inheritedEventCount).toBe(SessionLogOffset(0))
  })
})
