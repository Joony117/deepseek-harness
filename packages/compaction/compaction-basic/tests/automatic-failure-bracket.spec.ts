/**
 * The synthetic automatic-failure bracket this backend appends for an automatic
 * compaction failure that never reached the region transaction: a hand-built
 * `compaction/start` / `compaction/end` pair. The pair must name the exact
 * open turn, its close must name the same compaction, an error-carrying close
 * has no `compaction/summary`, and no turn boundary may fall inside it.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'

const MODEL = 'test-model'
const SIGNAL = new AbortController().signal

/** A registered route; the spec fails its model lookup so pressure resolution fails before the region opens. */
class CapacitylessAdapter extends LlmAdapter {
  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new CapacitylessAdapter())
  return ctx
}

/** Closed two-message turns followed by one open turn, built through the store. */
function conversation(ctx: Context, turns = 4): Session {
  const text = 'fixture '.repeat(40).trim()
  const session = ctx.sessions.create()
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

describe('automatic compaction failure bracket', () => {
  it('appends one closed bracket for the open turn and leaves no open compaction behind', async () => {
    const ctx = await setup()
    // `recordAutomaticFailure` swallows a failed append into exactly one
    // warning, so capturing warnings makes a rejection visible here.
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => { warnings.push(message) }) as typeof ctx.logger.warn
    // Fail the route lookup: pressure resolution fails before
    // `compactSurfaceRegion` runs, so no region-owned bracket exists. (A route
    // with no context metadata is a config error at rc.2: warned, not recorded.)
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockRejectedValue(new Error('model route unavailable'))
    void new BasicCompactionEngine(ctx, { thresholdRatio: 0.5, retainTokens: 180 })
    const session = conversation(ctx)
    const owner = { session, options: { provider: MODEL, model: MODEL } } as Agent

    await expect(agentEvents(ctx, owner).waterfall(
      'agent/pre-step', { modelSelection: { provider: MODEL, model: MODEL }, messages: [], turn: 5, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )).resolves.toEqual({ kind: 'enter', messages: [] })

    expect(warnings.filter(message => message.includes('could not record'))).toEqual([])

    const events = session.snapshotEvents()
    const starts = events.filter(event => event.type === 'compaction/start')
    const ends = events.filter(event => event.type === 'compaction/end')
    expect(starts).toHaveLength(1)
    expect(ends).toHaveLength(1)
    const [start] = starts
    const [end] = ends
    expect(start!.data.turn).toBe(5)
    expect(end!.data).toMatchObject({ compactionId: start!.data.compactionId, turn: 5 })
    expect(end!.data.error).toContain('model route unavailable')
    expect(events.some(event => event.type === 'compaction/summary')).toBe(false)
    // The clause the pre-rc.1 patch violated: no turn boundary inside the bracket.
    const inside = events.slice(events.indexOf(start!) + 1, events.indexOf(end!))
    expect(inside.filter(event => event.type === 'turn/start' || event.type === 'turn/end')).toEqual([])

    expect(() => session.append('turn/end', { turn: 5, reason: { kind: 'completed' } })).not.toThrow()
    expect(() => session.append('turn/start', { turn: 6 })).not.toThrow()
  })
})
