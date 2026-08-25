import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { createApiRemoteAgentResolver } from '@deepseek-ai/dsh-api-remotes'
import { TypertLookupFailure } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'

const sid = (value: string): SessionId => value as SessionId

function header(id: SessionId): SessionHeader {
  return { version: 0, id, createdAt: 1, cwd: '/proj' }
}

async function createContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return ctx
}

function provideSession(
  ctx: Context,
  meta: SessionHeader,
  inspect: () => Promise<{ meta: SessionHeader; events: SessionEvent[] }>,
): void {
  ctx.provide('sessionPersistence', {
    list: () => Promise.resolve([meta]),
    inspect,
    locate: () => undefined,
  } as never)
}

function stubAgent(ctx: Context, session: Session): Agent {
  return { id: session.id, session, status: 'idle', ctx } as Agent
}

describe('API Remote Agent resolver races', () => {
  it('maps an inspected session without a cwd to session-not-found', async () => {
    const ctx = await createContext()
    const sessionId = sid('missing-after-inspect')
    const meta = header(sessionId)
    provideSession(ctx, meta, () => Promise.resolve({
      meta: { ...meta, cwd: undefined } as unknown as SessionHeader,
      events: [],
    }))

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ error: { code: 'session-not-found', details: { sessionId } } })
    await ctx.fiber.dispose()
  })

  it('resumes through a concurrently attached ordinary Session without optional defaults', async () => {
    const ctx = await createContext()
    const sessionId = sid('ordinary-attach-race')
    const meta = header(sessionId)
    let published: Session | undefined
    provideSession(ctx, meta, () => {
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return Promise.resolve({ meta, events: [] })
    })
    const resume = vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('Session was not published')
      return { agent: stubAgent(ctx, published), dispose: () => Promise.resolve() }
    })

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ agent: { id: sessionId } })
    expect(resume).toHaveBeenCalledWith({ resumeSessionId: sessionId })
    await ctx.fiber.dispose()
  })

  it('rejects a subagent Session published after durable inspection', async () => {
    const ctx = await createContext()
    const sessionId = sid('owned-attach-race')
    const meta = header(sessionId)
    provideSession(ctx, meta, () => {
      ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
      return Promise.resolve({ meta, events: [] })
    })
    const resume = vi.spyOn(ctx.agents, 'resume')

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ error: { code: 'agent-busy' } })
    expect(resume).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('reclassifies failed resumes after a live or attached subagent wins publication', async () => {
    for (const winner of ['agent', 'session'] as const) {
      const ctx = await createContext()
      const sessionId = sid(`owned-${winner}-resume-race`)
      const meta = header(sessionId)
      provideSession(ctx, meta, () => Promise.resolve({ meta, events: [] }))
      vi.spyOn(ctx.agents, 'resume').mockImplementationOnce(async () => {
        const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
        if (winner === 'agent') ctx.agents.register(stubAgent(ctx, session))
        throw new Error('session id already published')
      })

      const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

      expect(result).toMatchObject({ error: { code: 'agent-busy' } })
      await ctx.fiber.dispose()
    }
  })

  it('uses the shared cold-resume policy for the Agent Host Context', async () => {
    const ctx = await createContext()
    const sessionId = sid('context-cold-resume')
    const meta = header(sessionId)
    let published: Session | undefined
    provideSession(ctx, meta, () => {
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return Promise.resolve({ meta, events: [] })
    })
    const agentCtx = ctx.extend()
    vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('Session was not published')
      return { agent: stubAgent(agentCtx, published), dispose: () => Promise.resolve() }
    })
    const defaultProvider = ctx.typert.contexts.getHost('agent')
    createApiRemoteAgentResolver(ctx, {})
    await vi.waitFor(() => { expect(ctx.typert.contexts.getHost('agent')).not.toBe(defaultProvider) })
    const provider = ctx.typert.contexts.getHost('agent')
    if (provider === undefined) throw new Error('Agent Host Context provider was not mounted')

    await expect(provider.resolve(sessionId)).resolves.toBe(agentCtx)
    await ctx.fiber.dispose()
  })

  it('applies the subagent ownership fence to the Agent Host Context', async () => {
    const ctx = await createContext()
    const sessionId = sid('context-owned-subagent')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
    ctx.agents.register(stubAgent(ctx.extend(), session))
    const defaultProvider = ctx.typert.contexts.getHost('agent')
    createApiRemoteAgentResolver(ctx, {})
    await vi.waitFor(() => { expect(ctx.typert.contexts.getHost('agent')).not.toBe(defaultProvider) })
    const provider = ctx.typert.contexts.getHost('agent')
    if (provider === undefined) throw new Error('Agent Host Context provider was not mounted')

    const resolution = provider.resolve(sessionId)
    await expect(resolution).rejects.toBeInstanceOf(TypertLookupFailure)
    await expect(resolution).rejects.toMatchObject({ failure: { code: 'agent-busy' } })
    await ctx.fiber.dispose()
  })
})

describe('API Remote Agent resolver lifecycle hooks', () => {
  const fenced = (sessionId: SessionId) => ({
    code: 'agent-busy' as const,
    message: `session "${sessionId}" is being deleted`,
    details: { reason: 'a deletion holds this session lifecycle' },
  })

  it('consults the guard before handing back a live agent', async () => {
    const ctx = await createContext()
    const sessionId = sid('guarded-live-agent')
    const session = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
    const live = stubAgent(ctx.extend(), session)
    ctx.agents.register(live)
    const guard = vi.fn(() => fenced(sessionId))

    const result = await createApiRemoteAgentResolver(ctx, { guard })(sessionId)

    // The live agent is right there and would otherwise be returned; the whole
    // point of the fence is that an owner tearing this lifecycle down never
    // hands it to a new caller.
    expect(result).toEqual({ error: fenced(sessionId) })
    expect(result).not.toHaveProperty('agent')
    expect(guard).toHaveBeenCalledWith(sessionId)
    await ctx.fiber.dispose()
  })

  it('consults the guard again immediately before a cold resume publishes', async () => {
    const ctx = await createContext()
    const sessionId = sid('guarded-before-publication')
    const meta = header(sessionId)
    // Undefined on the way in, refusing by the time setup has awaited: exactly
    // the window a fence raised mid-resume has to close.
    const guard = vi.fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValue(fenced(sessionId))
    provideSession(ctx, meta, () => Promise.resolve({ meta, events: [] }))
    const resume = vi.spyOn(ctx.agents, 'resume')

    const result = await createApiRemoteAgentResolver(ctx, { guard })(sessionId)

    expect(result).toEqual({ error: fenced(sessionId) })
    expect(resume).not.toHaveBeenCalled()
    expect(guard.mock.calls.length).toBeGreaterThanOrEqual(2)
    await ctx.fiber.dispose()
  })

  it('hands the acquire hook the exact handle the resume produced', async () => {
    const ctx = await createContext()
    const sessionId = sid('acquired-handle')
    const meta = header(sessionId)
    let published: Session | undefined
    provideSession(ctx, meta, () => {
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return Promise.resolve({ meta, events: [] })
    })
    let produced: AgentHandle | undefined
    vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('Session was not published')
      produced = { agent: stubAgent(ctx, published), dispose: () => Promise.resolve() }
      return produced
    })
    let received: AgentHandle | undefined
    const acquire = vi.fn(async (_id: SessionId, start: () => Promise<AgentHandle>) => {
      received = await start()
      return received
    })

    const result = await createApiRemoteAgentResolver(ctx, { acquire })(sessionId)

    // Identity, not shape: an owner that must later dispose precisely this
    // lifecycle cannot do it with a copy.
    expect(received).toBe(produced)
    expect(result).toMatchObject({ agent: { id: sessionId } })
    expect((result as { agent: Agent }).agent).toBe(produced?.agent)
    expect(acquire).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('invokes acquire at entry, before the cold resume reads the store', async () => {
    const ctx = await createContext()
    const sessionId = sid('acquire-at-entry')
    const meta = header(sessionId)
    const gate = Promise.withResolvers<void>()
    let inspects = 0
    let published: Session | undefined
    provideSession(ctx, meta, async () => {
      inspects++
      await gate.promise
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return { meta, events: [] }
    })
    vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('Session was not published')
      return { agent: stubAgent(ctx, published), dispose: () => Promise.resolve() }
    })
    let acquiredAt = -1
    const acquire = async (_id: SessionId, start: () => Promise<AgentHandle>) => {
      acquiredAt = inspects
      return start()
    }

    const resolving = createApiRemoteAgentResolver(ctx, { acquire })(sessionId)
    // Load-bearing: the owner learns this identity is activating BEFORE the
    // resolver's first await, not when it finally publishes. An owner that
    // fences the id during the inspect below would otherwise never see this
    // resume, and its late publication would rebind a deleted identity.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(acquiredAt).toBe(0)
    expect(inspects).toBe(1)

    gate.resolve()
    await expect(resolving).resolves.toMatchObject({ agent: { id: sessionId } })
    await ctx.fiber.dispose()
  })

  it('resumes through the registry directly when both hooks are omitted', async () => {
    const ctx = await createContext()
    const sessionId = sid('no-hooks-cold-resume')
    const meta = header(sessionId)
    let published: Session | undefined
    provideSession(ctx, meta, () => {
      published = ctx.sessions.create(sessionId, { meta: { cwd: '/proj' } })
      return Promise.resolve({ meta, events: [] })
    })
    const handle: AgentHandle = {
      agent: undefined as unknown as Agent,
      dispose: () => Promise.resolve(),
    }
    const resume = vi.spyOn(ctx.agents, 'resume').mockImplementation(async () => {
      if (published === undefined) throw new Error('Session was not published')
      handle.agent = stubAgent(ctx, published)
      return handle
    })

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ agent: { id: sessionId } })
    expect((result as { agent: Agent }).agent).toBe(handle.agent)
    expect(resume).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('keeps the subagent race refusal when both hooks are omitted', async () => {
    const ctx = await createContext()
    const sessionId = sid('no-hooks-subagent-race')
    const meta = header(sessionId)
    provideSession(ctx, meta, () => {
      ctx.sessions.create(sessionId, { meta: { cwd: '/proj', origin: 'subagent' } })
      return Promise.resolve({ meta, events: [] })
    })
    const resume = vi.spyOn(ctx.agents, 'resume')

    const result = await createApiRemoteAgentResolver(ctx, {})(sessionId)

    expect(result).toMatchObject({ error: { code: 'agent-busy' } })
    expect(resume).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
