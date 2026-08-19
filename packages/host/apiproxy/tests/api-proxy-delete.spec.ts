/** Session deletion refusal ordering, persistence dispatch, and cancellation. */

import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { describe, expect, it, vi } from 'vitest'

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

async function composed(service: SessionPersistence): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  ctx.provide('sessionPersistence', service as never)
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

  it('refuses an attached session before checking backend support or persistence', async () => {
    const sessionId = sid('session-live')
    const backend = persistence({ supportsDeletion: false })
    const ctx = await composed(backend.service)
    ctx.sessions.create(sessionId, { meta: { cwd: '/project' } })

    const response = await api(ctx).sessions.delete(request(sessionId), new AbortController().signal)

    expect(response.result).toMatchObject({
      ok: false,
      error: { code: 'session-delete-unavailable', details: { sessionId } },
    })
    expect(backend.list).not.toHaveBeenCalled()
    expect(backend.remove).not.toHaveBeenCalled()
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
