/** Session deletion refusal ordering, persistence dispatch, and cancellation. */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { meta, oneTurnLog } from '../../../session/session-persistence/tests/contract.ts'

const sid = (id: string): SessionId => id as SessionId

function request(sessionId: SessionId): RpcRequest<{ sessionId: SessionId }> {
  return { rpcId: RpcId(`delete-${sessionId}`), payload: { sessionId } }
}

function header(id: SessionId): SessionHeader {
  return { version: 0, id, createdAt: 1, cwd: '/project' }
}

function persistence(options: {
  supportsDeletion?: boolean
  headers?: SessionHeader[]
} = {}): {
  service: SessionPersistence
  list: ReturnType<typeof vi.fn<(signal?: AbortSignal) => Promise<SessionHeader[]>>>
  remove: ReturnType<typeof vi.fn<(id: SessionId, signal?: AbortSignal) => Promise<void>>>
} {
  const list = vi.fn<(signal?: AbortSignal) => Promise<SessionHeader[]>>()
    .mockResolvedValue(options.headers ?? [])
  const remove = vi.fn<(id: SessionId, signal?: AbortSignal) => Promise<void>>()
    .mockResolvedValue(undefined)
  return {
    service: {
      supportsDeletion: options.supportsDeletion ?? true,
      list,
      delete: remove,
    } as unknown as SessionPersistence,
    list,
    remove,
  }
}

async function composed(service: SessionPersistence, running: SessionId[] = []): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  ctx.provide('sessionPersistence', service as never)
  // Deletion asks the Agent registry for in-flight work, not the session store:
  // the list path hydrates served sessions into the store, so residency there
  // says nothing about busyness.
  const busy = new Set<SessionId>(running)
  ctx.provide('agents', {
    get: (id: SessionId) => busy.has(id) ? { status: 'running' } : undefined,
  } as never)
  return ctx
}

const api = (ctx: Context) => createApiProxy(ctx, {
  defaultModelSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
  cwd: '/tmp',
})

describe('sessions.delete', () => {
  it('deletes a known detached session through the persistence backend', async () => {
    const sessionId = sid('session-old')
    const backend = persistence({ headers: [header(sessionId)] })
    const ctx = await composed(backend.service)
    const signal = new AbortController().signal

    const response = await api(ctx).sessions.delete(request(sessionId), signal)

    expect(response.result).toEqual({ ok: true, value: { deleted: true } })
    expect(backend.list).toHaveBeenCalledWith(signal)
    expect(backend.remove).toHaveBeenCalledWith(sessionId, signal)
    await ctx.fiber.dispose()
  })

  it('refuses a running session before checking backend support or persistence', async () => {
    const sessionId = sid('session-live')
    const backend = persistence({ supportsDeletion: false })
    const ctx = await composed(backend.service, [sessionId])

    const response = await api(ctx).sessions.delete(request(sessionId), new AbortController().signal)

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'session-delete-unavailable', details: { sessionId } },
    })
    expect(backend.list).not.toHaveBeenCalled()
    expect(backend.remove).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  // Regression: guarding on ctx.sessions residency made every listed row
  // undeletable, because serving a list hydrates its sessions into the store.
  it('deletes a store-resident session that is not running', async () => {
    const sessionId = sid('session-idle')
    const backend = persistence({ headers: [header(sessionId)] })
    const ctx = await composed(backend.service)
    ctx.sessions.create(sessionId, { meta: { cwd: '/project' } })

    const response = await api(ctx).sessions.delete(request(sessionId), new AbortController().signal)

    expect(response.result).toEqual({ ok: true, value: { deleted: true } })
    expect(backend.remove).toHaveBeenCalledWith(sessionId, expect.anything())
    await ctx.fiber.dispose()
  })

  // Regression: the seam was read as a bare ctx property, which cordis rejects
  // for an undeclared injection, so every reachable delete threw at runtime.
  it('reports an unsupported backend when no persistence is mounted at all', async () => {
    const sessionId = sid('session-old')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    ctx.provide('agents', { get: () => undefined } as never)

    const response = await api(ctx).sessions.delete(request(sessionId), new AbortController().signal)

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'session-delete-unsupported', details: { sessionId } },
    })
    await ctx.fiber.dispose()
  })

  it('distinguishes an unsupported backend before listing persistence', async () => {
    const sessionId = sid('session-old')
    const backend = persistence({ supportsDeletion: false, headers: [header(sessionId)] })
    const ctx = await composed(backend.service)

    const response = await api(ctx).sessions.delete(request(sessionId), new AbortController().signal)

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'session-delete-unsupported', details: { sessionId } },
    })
    expect(backend.list).not.toHaveBeenCalled()
    expect(backend.remove).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('maps a missing persisted id to session-not-found without deleting', async () => {
    const sessionId = sid('session-missing')
    const backend = persistence()
    const ctx = await composed(backend.service)

    const response = await api(ctx).sessions.delete(request(sessionId), new AbortController().signal)

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'session-not-found', details: { sessionId } },
    })
    expect(backend.remove).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('reports cancellation when the persistence lookup aborts mid-flight', async () => {
    const sessionId = sid('session-old')
    const backend = persistence()
    backend.list.mockImplementation(signal => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const ctx = await composed(backend.service)
    const controller = new AbortController()

    const pending = api(ctx).sessions.delete(request(sessionId), controller.signal)
    controller.abort(new Error('cancel delete'))
    const response = await pending

    expect(response.result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(backend.remove).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})

describe('sessions.delete attached live jsonl session', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  /**
   * A real JSONL artifact on disk with no coordinator tracking it, so the next
   * mount takes the adoptLivePrefix path and a live Session genuinely owns the
   * stored prefix. This is the state a selected session is in.
   */
  async function storedSession(id: string): Promise<{
    root: string
    m: SessionHeader
    log: SessionEvent[]
  }> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-apiproxy-delete-'))
    dirs.push(root)
    const m = meta(id, '/work')
    const log = oneTurnLog()
    const writer = new Context()
    await writer.plugin(SessionStore)
    await writer.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await writer.sessionPersistence.create(m)
    await writer.sessionPersistence.append(m.id, log)
    await writer.fiber.dispose()
    return { root, m, log }
  }

  /**
   * The Agent registry is the only double here: the Session, the persistence
   * coordinator and the on-disk artifact are all real. `resume` publishes a
   * genuine live Session inside its own fiber, so disposing the handle really
   * emits `session/disposed` and really arms the coordinator's retirement --
   * which is the whole mechanism under test.
   */
  async function hostedProxy(root: string, m: SessionHeader, options: {
    gateResume?: Promise<void>
    gateInspect?: Promise<void>
    status?: () => 'idle' | 'running'
  } = {}): Promise<{
    ctx: Context
    proxy: ReturnType<typeof api>
    inspects: () => number
    replaceLiveAgent: () => void
    resumes: () => number
    disposals: () => number
    registerForeign: () => Promise<void>
  }> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const registry = new Map<SessionId, Agent>()
    let resumes = 0
    let disposals = 0
    let inspects = 0
    if (options.gateInspect !== undefined) {
      // Parks `ensureSession` AFTER its synchronous entry and BEFORE it reaches
      // activate -- the window where a resume that started ahead of a deletion
      // used to be invisible to it.
      const persistence = ctx.sessionPersistence
      const realInspect = persistence.inspect.bind(persistence)
      persistence.inspect = (async (id: SessionId, signal?: AbortSignal) => {
        inspects++
        await options.gateInspect
        return realInspect(id, signal)
      }) as typeof persistence.inspect
    }

    /**
     * The real resume publication sequence: reserve the stored prefix through
     * the coordinator, publish that exact Session, then release the
     * reservation. Seeding a fresh Session over a stored prefix is refused
     * ("persisted state already owns this identity"), and it is precisely this
     * path that binds `states.owner` via adoptLivePrefix.
     */
    const publishStored = async (): Promise<{ session: Session; detach: () => void }> => {
      const preparation = await ctx.sessionPersistence.prepare(m.id)
      const session = preparation.session
      const detach = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      preparation[Symbol.dispose]()
      return { session, detach }
    }

    const publish = async (): Promise<{ agent: Agent; dispose: () => Promise<void> }> => {
      resumes++
      if (options.gateResume !== undefined) await options.gateResume
      const { session: created, detach } = await publishStored()
      const agent = {
        id: created.id,
        session: created,
        get status() { return options.status?.() ?? 'idle' },
        ctx,
      } as unknown as Agent
      registry.set(created.id, agent)
      return {
        agent,
        dispose: async () => {
          disposals++
          registry.delete(created.id)
          detach()
          await Promise.resolve()
        },
      }
    }

    ctx.provide('agents', {
      get: (id: SessionId) => registry.get(id),
      list: () => [...registry.values()],
      isOwnedBy: () => false,
      resume: publish,
      create: publish,
    } as never)

    // One proxy per host: createApiProxy registers a user-questions
    // provider, and a second registration on the same Context throws.
    return {
      ctx,
      proxy: api(ctx),
      inspects: () => inspects,
      resumes: () => resumes,
      disposals: () => disposals,
      // A live agent this proxy never activated: no retained handle exists for
      // it, which must stay a refusal rather than a teardown of an Agent scope
      // owned by someone else.
      // Swap in a different Agent object for the same id, leaving the retained
      // handle pointing at the previous instance.
      replaceLiveAgent: () => {
        const current = registry.get(m.id)
        if (current === undefined) throw new Error('expected a live agent to replace')
        registry.set(m.id, { id: m.id, session: current.session, status: 'idle', ctx } as unknown as Agent)
      },
      registerForeign: async () => {
        // Published WITHOUT going through the proxy, so no handle is retained.
        const { session: foreign } = await publishStored()
        registry.set(m.id, { id: m.id, session: foreign, status: 'idle', ctx } as unknown as Agent)
      },
    }
  }

  const attach = (proxy: ReturnType<typeof api>, sessionId: SessionId): Promise<unknown> =>
    proxy.sessions.create({
      rpcId: RpcId(`create-${sessionId}`),
      payload: { sessionId, cwd: '/work' },
    } as never)

  it('deletes an attached idle session and removes its directory from disk', async () => {
    const { root, m } = await storedSession('delete-attached-idle')
    const host = await hostedProxy(root, m)
    const { ctx } = host

    try {
      await attach(host.proxy, m.id)
      const location = ctx.sessionPersistence.locate(m)
      if (location === undefined) throw new Error('expected a jsonl session location')
      const dir = dirname(location.path)
      // Idle, attached, and genuinely owning the stored prefix.
      expect(ctx.agents.get(m.id)?.status).toBe('idle')
      expect(ctx.sessions.get(m.id)).toBeDefined()
      expect((await stat(dir)).isDirectory()).toBe(true)
      expect(host.resumes()).toBe(1)

      const response = await host.proxy.sessions.delete(request(m.id), new AbortController().signal)

      expect(response.result).toEqual({ ok: true, value: { deleted: true } })
      // Exactly one handle torn down: the one this proxy activated.
      expect(host.disposals()).toBe(1)
      expect(ctx.sessions.get(m.id)).toBeUndefined()
      await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('captures an activation that began before the fence, then disposes it', async () => {
    const { root, m } = await storedSession('delete-races-earlier-resume')
    const gate = Promise.withResolvers<void>()
    const host = await hostedProxy(root, m, { gateResume: gate.promise })
    const { ctx } = host

    try {
      // Resume is in flight and blocked when the deletion raises its fence.
      const attaching = attach(host.proxy, m.id)
      await vi.waitFor(() => { expect(host.resumes()).toBe(1) })
      let settled = false
      const deletion = host.proxy.sessions.delete(request(m.id), new AbortController().signal)
        .then((value) => { settled = true; return value })
      await new Promise(resolve => setTimeout(resolve, 25))
      // Load-bearing: the deletion must be PARKED on the activation it
      // captured. A deletion that ran ahead here would remove the artifact
      // while the resume is still gated, and the resume would then publish a
      // live session over a session that no longer exists.
      expect(settled).toBe(false)
      expect(host.disposals()).toBe(0)
      gate.resolve()

      await attaching
      const response = await deletion

      // The earlier activation was awaited and its handle disposed, not
      // orphaned: had the deletion skipped it, the live Session would still own
      // the prefix and the coordinator would have refused.
      expect(response.result).toEqual({ ok: true, value: { deleted: true } })
      expect(host.disposals()).toBe(1)
      expect(ctx.sessions.get(m.id)).toBeUndefined()
      const location = ctx.sessionPersistence.locate(m)
      if (location === undefined) throw new Error('expected a jsonl session location')
      await expect(stat(dirname(location.path))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      gate.resolve()
      await ctx.fiber.dispose()
    }
  })

  it('refuses a resume raised after the fence, so nothing rebinds the prefix', async () => {
    const { root, m } = await storedSession('delete-races-later-resume')
    const host = await hostedProxy(root, m)
    const { ctx } = host

    try {
      await attach(host.proxy, m.id)
      expect(host.resumes()).toBe(1)

      // `sessions.delete` raises the fence synchronously, so this resume is
      // issued strictly inside the deletion window.
      const deletion = host.proxy.sessions.delete(request(m.id), new AbortController().signal)
      const raced = await attach(host.proxy, m.id)
      const response = await deletion

      expect(response.result).toEqual({ ok: true, value: { deleted: true } })
      expect(raced).toMatchObject({ result: { ok: false, error: { code: 'agent-busy' } } })
      // Asserted on the registry and the store, not on a message: no second
      // lifecycle was ever published, so nothing could rebind states.owner
      // between the disposal and the durable removal.
      expect(host.resumes()).toBe(1)
      expect(host.disposals()).toBe(1)
      expect(ctx.sessions.get(m.id)).toBeUndefined()
      expect(ctx.agents.get(m.id)).toBeUndefined()
      const location = ctx.sessionPersistence.locate(m)
      if (location === undefined) throw new Error('expected a jsonl session location')
      await expect(stat(dirname(location.path))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('captures a resume that began before the fence but activates after it', async () => {
    const { root, m } = await storedSession('delete-races-entry-window')
    const gate = Promise.withResolvers<void>()
    const host = await hostedProxy(root, m, { gateInspect: gate.promise })
    const { ctx } = host

    try {
      const location = ctx.sessionPersistence.locate(m)
      if (location === undefined) throw new Error('expected a jsonl session location')
      const dir = dirname(location.path)

      // The resume is past its fence check and parked mid-inspect. It has not
      // activated anything yet, so `retainedHandles` and `ctx.agents` are both
      // empty -- a deletion that only looked at those would see an idle,
      // detached session and step straight over this in-flight resume.
      const attaching = attach(host.proxy, m.id)
      await vi.waitFor(() => { expect(host.inspects()).toBe(1) })
      expect(ctx.agents.get(m.id)).toBeUndefined()

      let settled = false
      const deletion = host.proxy.sessions.delete(request(m.id), new AbortController().signal)
        .then((value) => { settled = true; return value })
      await new Promise(resolve => setTimeout(resolve, 25))
      // Load-bearing: the deletion must be parked on the activation this resume
      // registered at ENTRY. Registering only at activate() would leave this
      // window uncovered and the deletion would already have finished here.
      expect(settled).toBe(false)

      gate.resolve()
      const raced = await attaching
      const response = await deletion

      // The late activation met the fence and was refused, so nothing published
      // and nothing rebound states.owner onto a deleted id. This is the
      // invariant the entry registration exists to protect.
      expect(raced).toMatchObject({ result: { ok: false, error: { code: 'agent-busy' } } })
      expect(host.resumes()).toBe(0)
      expect(ctx.sessions.get(m.id)).toBeUndefined()
      expect(ctx.agents.get(m.id)).toBeUndefined()
      // The deletion either wins outright, or is honestly refused because the
      // abandoned resume's own `inspect` still holds a coordinator preparation
      // -- a refusal the spec deliberately keeps. Which one it is depends on
      // how fast that preparation drains, so the assertion is on the pair:
      // the artifact is never left half-removed.
      if (response.result.ok) {
        await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        expect(response.result.error.code).toBe('session-delete-unavailable')
        expect((await stat(dir)).isDirectory()).toBe(true)
      }
    } finally {
      gate.resolve()
      await ctx.fiber.dispose()
    }
  })

  it('refuses a running attached session before disposing anything', async () => {
    const { root, m } = await storedSession('delete-attached-running')
    const host = await hostedProxy(root, m, { status: () => 'running' })
    const { ctx } = host

    try {
      await attach(host.proxy, m.id)
      const location = ctx.sessionPersistence.locate(m)
      if (location === undefined) throw new Error('expected a jsonl session location')
      const before = await readFile(location.path)

      const response = await host.proxy.sessions.delete(request(m.id), new AbortController().signal)

      expect(response.result).toMatchObject({
        ok: false,
        error: { code: 'session-delete-unavailable', details: { sessionId: m.id } },
      })
      expect(host.disposals()).toBe(0)
      expect(await readFile(location.path)).toEqual(before)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports session-delete-unavailable for a live agent it does not own', async () => {
    const { root, m } = await storedSession('delete-foreign-live')
    const host = await hostedProxy(root, m)
    const { ctx } = host

    try {
      await host.registerForeign()
      const location = ctx.sessionPersistence.locate(m)
      if (location === undefined) throw new Error('expected a jsonl session location')
      const before = await readFile(location.path)

      const response = await host.proxy.sessions.delete(request(m.id), new AbortController().signal)

      expect(response.result).toMatchObject({
        ok: false,
        error: {
          code: 'session-delete-unavailable',
          message: `session "${m.id}" cannot be deleted while it is open or persistence work is in flight; retry once it settles, or restart the harness if it stays open`,
          details: { sessionId: m.id },
        },
      })
      expect(response.result).not.toMatchObject({ error: { code: 'internal' } })
      // No handle, so no teardown of an Agent scope this proxy never created.
      expect(host.disposals()).toBe(0)
      expect((await stat(dirname(location.path))).isDirectory()).toBe(true)
      expect(await readFile(location.path)).toEqual(before)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses when the retained handle no longer matches the live agent', async () => {
    const { root, m } = await storedSession('delete-stale-handle')
    const host = await hostedProxy(root, m)
    const { ctx } = host

    try {
      await attach(host.proxy, m.id)
      const location = ctx.sessionPersistence.locate(m)
      if (location === undefined) throw new Error('expected a jsonl session location')
      const before = await readFile(location.path)
      // Same id, a DIFFERENT Agent instance: whatever this proxy retained is
      // now stale. Disposing it would tear down a lifecycle nobody asked about
      // and leave the one actually holding the prefix in place.
      host.replaceLiveAgent()

      const response = await host.proxy.sessions.delete(request(m.id), new AbortController().signal)

      expect(response.result).toMatchObject({
        ok: false,
        error: { code: 'session-delete-unavailable', details: { sessionId: m.id } },
      })
      expect(host.disposals()).toBe(0)
      expect(await readFile(location.path)).toEqual(before)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('cancels before disposing when the signal aborts', async () => {
    const { root, m } = await storedSession('delete-attached-cancelled')
    const host = await hostedProxy(root, m)
    const { ctx } = host

    try {
      await attach(host.proxy, m.id)
      const location = ctx.sessionPersistence.locate(m)
      if (location === undefined) throw new Error('expected a jsonl session location')
      const controller = new AbortController()
      controller.abort(new Error('cancel delete'))

      const response = await host.proxy.sessions.delete(request(m.id), controller.signal)

      expect(response.result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
      expect(host.disposals()).toBe(0)
      expect((await stat(dirname(location.path))).isDirectory()).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('deletes a detached jsonl session with no live owner', async () => {
    const { root, m } = await storedSession('delete-detached-cold')
    const host = await hostedProxy(root, m)
    const { ctx } = host

    try {
      const location = ctx.sessionPersistence.locate(m)
      if (location === undefined) throw new Error('expected a jsonl session location')

      const response = await host.proxy.sessions.delete(request(m.id), new AbortController().signal)

      expect(response.result).toEqual({ ok: true, value: { deleted: true } })
      // Nothing was ever activated, so nothing was disposed.
      expect(host.resumes()).toBe(0)
      expect(host.disposals()).toBe(0)
      await expect(stat(dirname(location.path))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
