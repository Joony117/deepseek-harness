/**
 * The synthetic automatic-failure bracket, checked against the real
 * `@deepseek-ai/dsh-compaction` invariant companion.
 *
 * The bracket this backend appends for an automatic compaction failure that
 * never reached the region transaction is a hand-built `compaction/start` /
 * `compaction/end` pair. The invariant is the written contract for that pair:
 * a numbered bracket must name the exact open turn, its close must name the
 * same owner, an error-carrying close needs no `compaction/summary`, and no
 * turn boundary may cross a bracket that is still open. This file mounts the
 * companion for real so a violation fails at the append site rather than
 * silently poisoning a session in a deployment that opts invariants in.
 *
 * Its name matches the manual-topology convention in `scripts/test-invariants.ts`,
 * so this suite owns its own service tree.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'

const MODEL = 'test-model'
const SIGNAL = new AbortController().signal

/** A route advertising no context window, so pressure resolution fails before the region opens. */
class CapacitylessAdapter extends LlmAdapter {
  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(CompactionInvariant)
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

describe('automatic compaction failure bracket under the compaction invariant', () => {
  it('appends a bracket the invariant accepts and leaves no open compaction behind', async () => {
    const ctx = await setup()
    // `recordAutomaticFailure` swallows an append the invariant rejects into
    // exactly one warning, so capturing warnings is what makes a rejection
    // visible here instead of looking like "nothing was recorded".
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => { warnings.push(message) }) as typeof ctx.logger.warn
    // Resolve the route with no context metadata: pressure resolution fails
    // before `compactSurfaceRegion` runs, so no region-owned bracket exists.
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation((provider, model) => Promise.resolve({
      provider,
      id: model,
      name: model,
    }))
    void new BasicCompactionEngine(ctx, { thresholdRatio: 0.5, retainTokens: 180 })
    const session = conversation(ctx)
    const owner = { session, options: { provider: MODEL, model: MODEL } } as Agent

    // Every append below runs through the mounted invariant. It does NOT
    // surface here: the reporter catches its own append failure by design, so
    // the warning assertion two lines down is what reads the verdict.
    await expect(agentEvents(ctx, owner).waterfall(
      'agent/pre-step', { messages: [], turn: 5, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )).resolves.toEqual({ kind: 'enter', messages: [] })

    expect(warnings.filter(message => message.includes('could not record'))).toEqual([])

    const events = session.snapshotEvents()
    const start = events.find(event => event.type === 'compaction/start')
    const end = events.find(event => event.type === 'compaction/end')
    expect(start?.data.turn).toBe(5)
    expect(end?.data.turn).toBe(5)
    expect(end?.data.error).toContain(`no context capacity for ${MODEL}/${MODEL}`)

    // The clause the pre-rc.1 patch violated: a turn boundary may not cross an
    // open bracket, so a session carrying an orphaned start poisons its own
    // next turn/end. The recorded pair is closed, so this append succeeds.
    expect(() => session.append('turn/end', { turn: 5, reason: { kind: 'completed' } })).not.toThrow()
    expect(() => session.append('turn/start', { turn: 6 })).not.toThrow()
  })
})
