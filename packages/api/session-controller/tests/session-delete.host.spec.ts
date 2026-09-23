/**
 * Durable Session deletion: the removal fence, its refusals, and the single
 * authoritative removal event.
 *
 * THE binding invariant under test: the client-facing row stays visible until
 * the backend confirms durable absence. Disposing the attached Agent is a
 * lifecycle transition, NOT proof of deletion, so a refusal or a backend
 * failure must leave `api-session/removed` unpublished and report
 * `api-session/error` against the surviving Session instead.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionDeleteConflictError } from '@deepseek-ai/dsh-session-persistence'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSessionTestController,
  createSessionTestRemote,
  installSessionReadTestServices,
  testSessionPersistence,
  type TestSessionRemote,
} from './test-remote.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Real directory: `createOrAdopt` mkdirs the project cwd before publishing. */
const CWD = mkdtempSync(join(tmpdir(), 'dsh-session-delete-'))

/** The durable side of the world, so "the artifact is gone" is an assertion and not a spy count. */
interface DurableStore {
  readonly artifacts: Set<SessionId>
  readonly deletes: SessionId[]
  /** Programmable backend outcome for the durable delete. */
  failDelete: (() => unknown) | undefined
  /** Optional hold inside the durable delete, so a second call can overlap the first. */
  holdDelete: (() => Promise<void>) | undefined
  /** Optional hold inside the stored-session listing, so a resume can stay in flight. */
  holdList: (() => Promise<void>) | undefined
}

interface Bench {
  readonly ctx: Context
  readonly remote: TestSessionRemote
  readonly durable: DurableStore
  /** Every `api-session/removed` this Host published, in order. */
  readonly removed: SessionId[]
  /** Every `api-session/error` this Host published, in order. */
  readonly errors: { sessionId: SessionId; message: string }[]
}

/**
 * Agent factory whose handle really tears its lifecycle down: `dispose()`
 * unregisters the Agent and detaches the Session, so `agent/disposed` and
 * `session/disposed` both fire exactly as they do in production. That is what
 * makes the removal fence observable at all.
 * @param ctx - the harness root context owning the store and registry.
 * @returns the factory installed with `ctx.agents.setFactory`.
 */
function liveFactory(ctx: Context): AgentFactory {
  return {
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const session = ctx.sessions.prepare(options.sessionId, {
        ...(options.meta === undefined ? {} : { meta: options.meta }),
      })
      const detachSession = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      const agent = {} as Agent
      Object.assign(agent, {
        id: session.id,
        session,
        status: 'idle',
        ctx: ownerCtx.extend({ agent }),
      })
      await options.setup?.(agent.ctx, agent)
      const unregister = ctx.agents.register(agent)
      return {
        agent,
        dispose: () => {
          unregister()
          detachSession()
          return Promise.resolve()
        },
      }
    },
    resume: () => Promise.reject(new Error('resume is not configured in this test')),
  }
}

/**
 * Factory whose returned handle no longer names the live Agent for the
 * identity - the shape a superseded incarnation leaves behind. `retain()` keys
 * on the handle's own Agent, so the retained entry is stale by construction.
 * @param ctx - the harness root context.
 * @returns the factory installed with `ctx.agents.setFactory`.
 */
function staleHandleFactory(ctx: Context): AgentFactory {
  const base = liveFactory(ctx)
  return {
    ...base,
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const handle = await base.createAgent(ownerCtx, options)
      return { ...handle, agent: { ...handle.agent } }
    },
  }
}

/**
 * Factory whose disposal always rejects while leaving the lifecycle attached,
 * and hands the real teardown to the test instead. Separating the two is what
 * makes the post-failure state observable: the Session is still in the store,
 * so its eventual `session/disposed` is a genuine edge and not a replay.
 * @param ctx - the harness root context.
 * @param teardowns - per-identity real teardown, run by the test after the failed delete.
 * @returns the factory installed with `ctx.agents.setFactory`.
 */
function disposeRejectsFactory(ctx: Context, teardowns: Map<SessionId, () => void>): AgentFactory {
  const base = liveFactory(ctx)
  return {
    ...base,
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      const handle = await base.createAgent(ownerCtx, options)
      teardowns.set(handle.agent.id, () => { void handle.dispose() })
      return { ...handle, dispose: () => Promise.reject(new Error('agent scope teardown failed')) }
    },
  }
}

/**
 * Factory whose `createAgent` waits on a test-owned gate, so a create can be
 * admitted and still in flight when a deletion raises its fence.
 * @param ctx - the harness root context.
 * @param entered - resolved when a create reaches the factory.
 * @param gate - the create finishes only after this settles.
 * @returns the factory installed with `ctx.agents.setFactory`.
 */
function gatedCreateFactory(
  ctx: Context,
  entered: PromiseWithResolvers<undefined>,
  gate: Promise<undefined>,
): AgentFactory {
  const base = liveFactory(ctx)
  return {
    ...base,
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      entered.resolve(undefined)
      await gate
      return base.createAgent(ownerCtx, options)
    },
  }
}

async function bench(options: {
  supportsDeletion?: boolean
  factory?: (ctx: Context) => AgentFactory
} = {}): Promise<Bench> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  const durable: DurableStore = {
    artifacts: new Set(), deletes: [], failDelete: undefined, holdDelete: undefined, holdList: undefined,
  }
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: async () => {
      await durable.holdList?.()
      return []
    },
    inspect: () => Promise.resolve(undefined),
    supportsDeletion: options.supportsDeletion ?? true,
    delete: async (sessionId: SessionId, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      durable.deletes.push(sessionId)
      const failure = durable.failDelete?.()
      if (failure !== undefined) throw failure
      // Held BEFORE the artifact goes, so a test can observe the world exactly
      // as an in-flight deletion leaves it rather than after the fact.
      await durable.holdDelete?.()
      durable.artifacts.delete(sessionId)
    },
  }) as never)
  ctx.agents.setFactory((options.factory ?? liveFactory)(ctx))
  const removed: SessionId[] = []
  const errors: { sessionId: SessionId; message: string }[] = []
  ctx.on('api-session/removed', (sessionId) => { removed.push(sessionId) })
  ctx.on('api-session/error', (sessionId, message) => { errors.push({ sessionId, message }) })
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    cwd: CWD,
  })
  return { ctx, remote, durable, removed, errors }
}

/** Register a live Agent this controller never activated (no retained handle). */
function foreignAgent(
  b: Bench,
  id: string,
  meta: { status?: 'idle' | 'running'; origin?: 'subagent' } = {},
): Agent {
  const session = b.ctx.sessions.create(SessionId(id), {
    meta: { cwd: CWD, ...(meta.origin === undefined ? {} : { origin: meta.origin }) },
  })
  const agent = { id: session.id, session, status: meta.status ?? 'idle', ctx: b.ctx } as Agent
  b.ctx.agents.register(agent)
  b.durable.artifacts.add(session.id)
  return agent
}

/** A cold identity with a durable artifact and no lifecycle anywhere. */
function detached(b: Bench, id: string): SessionId {
  const sessionId = SessionId(id)
  b.durable.artifacts.add(sessionId)
  return sessionId
}

function failureOf(result: { ok: boolean; error?: RemoteFailure }): RemoteFailure {
  if (result.ok || result.error === undefined) throw new Error('expected a failed delete')
  return result.error
}

describe('sessions.delete durable success', () => {
  it('removes the durable artifact and publishes exactly one removal for a detached Session', async () => {
    const b = await bench()
    const sessionId = detached(b, 'cold-session')

    const response = await b.remote.delete({ sessionId })

    expect(response.ok ? response.value : response.error).toEqual({ deleted: true })
    expect(b.durable.deletes).toEqual([sessionId])
    expect([...b.durable.artifacts]).toEqual([])
    expect(b.removed).toEqual([sessionId])
    expect(b.errors).toEqual([])
  })

  it('disposes an idle Agent it activated, then removes the row only after durable success', async () => {
    const b = await bench()
    const created = await b.remote.create({ cwd: CWD })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const sessionId = created.value.sessionId
    b.durable.artifacts.add(sessionId)
    expect(b.ctx.agents.get(sessionId)).toBeDefined()

    const response = await b.remote.delete({ sessionId })

    expect(response.ok).toBe(true)
    expect(b.ctx.agents.get(sessionId)).toBeUndefined()
    expect(b.ctx.sessions.get(sessionId)).toBeUndefined()
    expect([...b.durable.artifacts]).toEqual([])
    // Exactly once: the fence suppressed the disposal edge, and the
    // transaction published the authoritative one after durable absence.
    expect(b.removed).toEqual([sessionId])
    expect(b.errors).toEqual([])
  })
})

describe('sessions.delete leaves the surviving Session visible', () => {
  it('publishes no removal when the durable delete fails after the Agent was disposed', async () => {
    const b = await bench()
    const created = await b.remote.create({ cwd: CWD })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const sessionId = created.value.sessionId
    b.durable.artifacts.add(sessionId)
    b.durable.failDelete = () => new Error('backend volume is read-only')

    const response = await b.remote.delete({ sessionId })

    const failure = failureOf(response)
    expect(failure.code).toBe('gateway/internal')
    // The lifecycle really was torn down - this is the case the fence exists for.
    expect(b.ctx.sessions.get(sessionId)).toBeUndefined()
    // ...and the durable artifact survived, so the row is still a real Session.
    expect([...b.durable.artifacts]).toEqual([sessionId])
    // THE assertion: no connected client ever heard "removed".
    expect(b.removed).toEqual([])
    // The surviving row carries the error instead.
    expect(b.errors).toEqual([{ sessionId, message: failure.message }])
  })

  it('reports a persistence claim conflict as a delete-domain refusal', async () => {
    const b = await bench()
    const sessionId = detached(b, 'claimed-session')
    b.durable.failDelete = () => new SessionDeleteConflictError(sessionId, 'live')

    const failure = failureOf(await b.remote.delete({ sessionId }))

    expect(failure.code).toBe('session/delete-unavailable')
    expect(failure.details).toMatchObject({ sessionId, reason: 'persistence-conflict' })
    expect([...b.durable.artifacts]).toEqual([sessionId])
    expect(b.removed).toEqual([])
    expect(b.errors).toHaveLength(1)
  })
})

describe('sessions.delete refusals', () => {
  it.each([
    {
      name: 'a running Agent',
      reason: 'running',
      arrange: (b: Bench) => foreignAgent(b, 'running-session', { status: 'running' }).id,
    },
    {
      name: 'a subagent-owned Session',
      reason: 'subagent-owned',
      arrange: (b: Bench) => foreignAgent(b, 'child-session', { origin: 'subagent' }).id,
    },
    {
      name: 'a live Agent this service never activated',
      reason: 'foreign-agent',
      arrange: (b: Bench) => foreignAgent(b, 'foreign-session').id,
    },
  ])('refuses $name without touching the row or the artifact', async ({ reason, arrange }) => {
    const b = await bench()
    const sessionId = arrange(b)

    const failure = failureOf(await b.remote.delete({ sessionId }))

    // Delete-domain, never the `session/agent-busy` routing refusal: a caller
    // must be able to tell "busy" from "you may not delete this".
    expect(failure.code).toBe('session/delete-unavailable')
    expect(failure.details).toMatchObject({ sessionId, reason })
    expect(b.durable.deletes).toEqual([])
    expect([...b.durable.artifacts]).toEqual([sessionId])
    expect(b.ctx.sessions.get(sessionId)).toBeDefined()
    expect(b.ctx.agents.get(sessionId)).toBeDefined()
    expect(b.removed).toEqual([])
    expect(b.errors).toHaveLength(1)
  })

  it('refuses a retained handle that no longer names the live Agent', async () => {
    const b = await bench({ factory: staleHandleFactory })
    const created = await b.remote.create({ cwd: CWD })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const sessionId = created.value.sessionId
    b.durable.artifacts.add(sessionId)

    const failure = failureOf(await b.remote.delete({ sessionId }))

    expect(failure.code).toBe('session/delete-unavailable')
    expect(failure.details).toMatchObject({ sessionId, reason: 'stale-handle' })
    expect(b.durable.deletes).toEqual([])
    expect([...b.durable.artifacts]).toEqual([sessionId])
    expect(b.ctx.sessions.get(sessionId)).toBeDefined()
    expect(b.removed).toEqual([])
  })

  it('refuses a backend that does not support deletion', async () => {
    const b = await bench({ supportsDeletion: false })
    const sessionId = detached(b, 'unsupported-session')

    const failure = failureOf(await b.remote.delete({ sessionId }))

    expect(failure.code).toBe('session/delete-unsupported')
    expect(failure.details).toMatchObject({ sessionId })
    expect(b.durable.deletes).toEqual([])
    expect([...b.durable.artifacts]).toEqual([sessionId])
    expect(b.removed).toEqual([])
    expect(b.errors).toHaveLength(1)
  })
})

describe('sessions.delete owns its fence and its marks', () => {
  it('refuses a second delete for an identity a deletion already holds', async () => {
    const b = await bench()
    const sessionId = detached(b, 'overlapping-delete')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let holding = false
    b.durable.holdDelete = () => {
      // Only the first delete is held. A second one that is wrongly admitted
      // must be free to finish, so the failure is an assertion and not a hang.
      if (holding) return Promise.resolve()
      holding = true
      entered.resolve(undefined)
      return release.promise
    }

    const first = b.remote.delete({ sessionId })
    await entered.promise

    // The fence is one entry per identity: a contender that shared it would
    // lower it on its own exit, mid-deletion.
    // Delete-domain, not the routing code: the caller asked to delete, so the
    // answer names a deletion condition rather than "this session is busy".
    const failure = failureOf(await b.remote.delete({ sessionId }))
    expect(failure.code).toBe('session/delete-unavailable')
    expect(failure.details).toMatchObject({ sessionId, reason: 'deleting' })
    expect(b.durable.deletes).toEqual([sessionId])
    // ...and the refusal took no ownership, so the incumbent's fence still
    // stands: activation for this identity stays refused while it runs.
    const blocked = failureOf(await b.remote.create({ cwd: CWD, sessionId }))
    expect(blocked.code).toBe('session/agent-busy')

    release.resolve(undefined)
    const settled = await first

    expect(settled.ok).toBe(true)
    expect([...b.durable.artifacts]).toEqual([])
    expect(b.removed).toEqual([sessionId])
  })

  it('awaits BOTH a resume and a create admitted before the fence', async () => {
    const createEntered = Promise.withResolvers<undefined>()
    const createGate = Promise.withResolvers<undefined>()
    const b = await bench({ factory: ctx => gatedCreateFactory(ctx, createEntered, createGate.promise) })
    const sessionId = SessionId('racing-activation')
    const controller = createSessionTestController(b.ctx, {
      defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
      cwd: CWD,
    })
    // Only the resume's stored-session lookup is held; the create's own
    // identity check, which comes second, passes straight through.
    const lookupEntered = Promise.withResolvers<undefined>()
    const lookupGate = Promise.withResolvers<undefined>()
    b.durable.holdList = () => {
      b.durable.holdList = undefined
      lookupEntered.resolve(undefined)
      return lookupGate.promise
    }

    // Both activations are admitted before the fence, and both are in flight.
    const resumed = controller.resolveAgent(sessionId)
    await lookupEntered.promise
    const created = b.remote.create({ cwd: CWD, sessionId })
    await createEntered.promise

    const deleted = b.remote.delete({ sessionId })
    // Settle the resume only. The create is still in flight, so the deletion
    // must not have reached the backend yet.
    lookupGate.resolve(undefined)
    await resumed
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(b.durable.deletes).toEqual([])

    createGate.resolve(undefined)
    expect((await created).ok).toBe(true)
    expect((await deleted).ok).toBe(true)
    // The create finished before the removal, so the deletion disposed it; no
    // lifecycle outlives the durable delete.
    expect(b.durable.deletes).toEqual([sessionId])
    expect(b.ctx.agents.get(sessionId)).toBeUndefined()
    expect(b.removed).toEqual([sessionId])
  })

  it('releases removal-event ownership when the disposal it marked rejects', async () => {
    const teardowns = new Map<SessionId, () => void>()
    const b = await bench({ factory: ctx => disposeRejectsFactory(ctx, teardowns) })
    const created = await b.remote.create({ cwd: CWD })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const sessionId = created.value.sessionId
    b.durable.artifacts.add(sessionId)

    const failure = failureOf(await b.remote.delete({ sessionId }))

    expect(failure.code).toBe('gateway/internal')
    // Disposal is the last reversible step, so its failure stops the delete
    // before the backend is ever asked.
    expect(b.durable.deletes).toEqual([])
    expect([...b.durable.artifacts]).toEqual([sessionId])
    expect(b.removed).toEqual([])

    // The mark that delete took is nobody's to hold now. This lifecycle's own
    // later disposal must publish its removal, or the row is unremovable for
    // the life of the process.
    const teardown = teardowns.get(sessionId)
    expect(teardown).toBeDefined()
    teardown?.()

    expect(b.removed).toEqual([sessionId])
  })
})
