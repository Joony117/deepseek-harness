/**
 * SessionProjectionCache behavior: mandatory-point writes (turn/end, detach),
 * count/interval throttling between them, fail-soft durability (a failed
 * write logs and stays stale, never throws into the event path), and the
 * synchronous cached listing read. The durable medium is the
 * `session_projcache` storage domain in per-record layout: one
 * version-stamped document per session under the json backend root at
 * `<root>/session_projcache/sessions/<id>.json`. Reads never touch the
 * medium — they come from the domain's in-memory tables, which writes mutate
 * only after durability.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import SessionStore, {
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionCache from '../src/index.ts'
import { checkpointRecord, projectionCacheDomainSpec } from '../src/spec.ts'
import type { CheckpointRecord } from '../src/spec.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'cache-test/marks': MarksState
    'cache-test/marks2': Map<string, string>
    'cache-test/count': number
    'cache-test/secret': string
    'cache-test/marks3': MarksState
  }
  interface SessionProjectionMap {
    'cache-test/marks': { marks: string[] }
    'cache-test/marks3': { marks: string[] }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'cache-test/mark': { marks: string[] }
  }

  interface OutOfBandSessionEventMap {
    'cache-test/mark': true
  }
}

type MarksState = { marks: string[] } | null
const marksUnit = (stateVersion = 1) => ({
  key: 'cache-test/marks',
  stateSchema: z.object({ marks: z.array(z.string()) }).nullable(),
  init: () => null,
  apply: (state, event) => (event.type === 'cache-test/mark' ? (event).data : state),
  wire: {
    viewSchema: z.object({ marks: z.array(z.string()) }),
    view: state => state ?? { marks: [] },
  },
  stateVersion,
}) satisfies ProjectionDefinition<'cache-test/marks', MarksState>

const marks3Unit = {
  key: 'cache-test/marks3',
  stateSchema: z.object({ marks: z.array(z.string()) }).nullable(),
  init: () => null,
  apply: state => state,
  wire: {
    viewSchema: z.object({ marks: z.array(z.string()) }),
    view: state => state ?? { marks: [] },
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'cache-test/marks3', MarksState>

const secretUnit = {
  key: 'cache-test/secret',
  stateSchema: z.string(),
  init: () => '',
  apply: state => state,
  stateVersion: 1,
} satisfies ProjectionDefinition<'cache-test/secret', string>

/** One session's record document on the per-record medium. */
const recordPath = (root: string, id: Session['id']): string =>
  join(root, projectionCacheDomainSpec.name, 'sessions', `${String(id)}.json`)

/** Header shape for cachedSnapshot calls. */
const headerOf = (id: SessionId, createdAt = 0, cwd?: string) =>
  ({ version: 0, id, createdAt, isSeeded: false, ...cwd === undefined ? {} : { cwd } })

interface HarnessOptions {
  root?: string
  config?: { writeEveryEvents: number; writeIntervalMs: number }
  stateVersion?: number
}

const contexts: Context[] = []
const roots: string[] = []

async function harness(options: HarnessOptions = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  // The cache opens its domain through the storage stack; the json backend
  // lands the per-record tree under this tmp root.
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(marksUnit(options.stateVersion))
  const fiber = await ctx.plugin(SessionProjectionCache, options.config ?? { writeEveryEvents: 100, writeIntervalMs: 60_000 })
  return { ctx, root, fiber, cache: ctx.sessionProjectionCache }
}

const mark = (session: Session, marks: string[]): SessionEvent =>
  session.append('cache-test/mark', { marks })

const endTurn = (session: Session): SessionEvent =>
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

/** The stored record for one session id (undefined = absent or unreadable). */
async function storedRecord(root: string, id: Session['id']): Promise<CheckpointRecord | undefined> {
  try {
    const document = JSON.parse(await readFile(recordPath(root, id), 'utf8')) as { record: unknown }
    return checkpointRecord.parse(document.record)
  } catch {
    return undefined
  }
}

/**
 * sha256 of every file under `root`, keyed by root-relative path. Digesting the
 * whole storage root rather than just the cache records is deliberate: a rejected
 * cleanup must leave the medium byte-identical, and this catches a write anywhere
 * beneath it, session-log bytes included.
 */
async function treeDigest(root: string): Promise<Record<string, string>> {
  const digests: Record<string, string> = {}
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const full = join(entry.parentPath, entry.name)
    digests[relative(root, full)] = createHash('sha256').update(await readFile(full)).digest('hex')
  }
  return digests
}

/** The stored rows for one session id (undefined = absent or unreadable). */
async function storedRows(root: string, id: Session['id']): Promise<CheckpointRecord['rows'] | undefined> {
  return (await storedRecord(root, id))?.rows
}

/** Pre-seed one session's record document with a stored checkpoint record. */
async function seedRecord(
  root: string,
  id: string,
  rows: CheckpointRecord['rows'],
  identity: CheckpointRecord['identity'] = {
    createdAt: 0,
    isSeeded: false,
    inheritedEventCount: SessionLogOffset(0),
  },
): Promise<void> {
  const path = recordPath(root, SessionId(id))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ version: projectionCacheDomainSpec.version, record: { identity, rows } }))
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })))
})

describe('SessionProjectionCache write policy', () => {
  it('writes a durable checkpoint at turn/end (mandatory point)', async () => {
    const { ctx, root } = await harness()
    const session = ctx.sessions.create(SessionId('turn-end'))
    mark(session, ['a'])
    // Creation already wrote the init cut; the mark is throttled, so the
    // stored row is still the creation-time cut (no marks folded).
    await vi.waitFor(async () => {
      expect((await storedRows(root, session.id))?.['cache-test/marks']?.seq).toBe(-1)
    }, { timeout: 5_000 })
    const end = endTurn(session)
    await vi.waitFor(async () => {
      expect((await storedRows(root, session.id))?.['cache-test/marks'])
        .toEqual({ ver: 1, seq: end.seq, val: { marks: ['a'] } })
    }, { timeout: 5_000 })
  })

  it('writes a checkpoint at session creation, capturing the seed-derived cut', async () => {
    const { ctx, root } = await harness()
    // A forked child seeded with its ancestor's title-like event: no
    // conversation follows, yet the creation write must capture the fold so
    // a crash or a live-held fork still lists the derived value.
    const session = ctx.sessions.create(SessionId('seeded'), {
      seed: [{ type: 'cache-test/mark', seq: 0, time: 1, data: { marks: ['seed'] } }] as SessionEvent[],
    })
    await vi.waitFor(async () => {
      expect((await storedRows(root, session.id))?.['cache-test/marks']?.val)
        .toEqual({ marks: ['seed'] })
    }, { timeout: 5_000 })
  })

  it('writes at session disposal (detach, the live-to-cold moment)', async () => {
    const { ctx, root } = await harness()
    // Sessions dispose with their owning fiber: create in a child plugin.
    let session: Session | undefined
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(SessionId('detach'))
    }, { inject: ['sessions'] }))
    if (session === undefined) throw new Error('session was not created')
    mark(session, ['live'])
    await owner.dispose()
    const detached = session
    await vi.waitFor(async () => {
      expect((await storedRows(root, detached.id))?.['cache-test/marks']?.val).toEqual({ marks: ['live'] })
    }, { timeout: 5_000 })
  })

  it('flushes when the in-turn event count reaches the configured threshold', async () => {
    const { ctx, root } = await harness({ config: { writeEveryEvents: 3, writeIntervalMs: 60_000 } })
    const session = ctx.sessions.create(SessionId('count'))
    mark(session, ['1'])
    mark(session, ['2'])
    await vi.waitFor(async () => {
      expect((await storedRows(root, session.id))?.['cache-test/marks']?.seq).toBe(-1) // still the creation cut
    }, { timeout: 5_000 })
    mark(session, ['3'])
    await vi.waitFor(async () => {
      expect((await storedRows(root, session.id))?.['cache-test/marks']?.val).toEqual({ marks: ['3'] })
    }, { timeout: 5_000 })
  })

  it('flushes on the configured interval when the count threshold is not reached', async () => {
    const { ctx, cache } = await harness({ config: { writeEveryEvents: 100, writeIntervalMs: 20 } })
    const write = vi.spyOn(cache, 'write').mockResolvedValue()
    vi.useFakeTimers()
    const session = ctx.sessions.create(SessionId('interval'))
    write.mockClear()
    mark(session, ['slow'])
    await vi.advanceTimersByTimeAsync(19)
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(write).toHaveBeenCalledExactlyOnceWith(session)
  })

  it('write() on a never-dirty session checkpoints directly and rejects a non-JSON unit state', async () => {
    const { ctx, root } = await harness()
    // Never dirtied: no events — write() still lands the init-derived cut.
    const clean = ctx.sessions.create(SessionId('clean-write'))
    await ctx.sessionProjectionCache.write(clean)
    expect((await storedRows(root, clean.id))?.['cache-test/marks']).toEqual({ ver: 1, seq: -1, val: null })
    // A unit whose state violates the plain-JSON contract fails the write loud.
    ctx.sessionProjections.register({
      key: 'cache-test/marks2',
      stateSchema: z.custom<Map<string, string>>(() => true),
      init: () => new Map<string, string>(),
      apply: state => state,
      stateVersion: 1,
    })
    await expect(ctx.sessionProjectionCache.write(clean)).rejects.toThrow('not losslessly JSON-serializable')
  })

  it('plugin disposal clears armed interval timers and leaves cleaned sessions alone', async () => {
    vi.useFakeTimers()
    const { ctx, root, fiber } = await harness({ config: { writeEveryEvents: 100, writeIntervalMs: 5000 } })
    const armed = ctx.sessions.create(SessionId('armed'))
    const cleaned = ctx.sessions.create(SessionId('cleaned'))
    mark(armed, ['pending']) // timer armed, no write yet
    mark(cleaned, ['done'])
    endTurn(cleaned) // mandatory write; markClean leaves {pending: 0, timer: undefined} in the map
    await vi.advanceTimersByTimeAsync(0)
    await fiber.dispose()
    // The armed timer died with the plugin: advancing time writes nothing.
    await vi.advanceTimersByTimeAsync(10_000)
    // Only the creation cut exists: the armed mark never wrote.
    expect((await storedRows(root, armed.id))?.['cache-test/marks']?.seq).toBe(-1)
  })

  it('contains a durable write failure: logs a warning, event path unharmed, next write self-heals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
    await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(marksUnit())
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    // A directory where the record document must land makes the atomic
    // rename fail — including the creation write, so no row ever lands.
    const blocker = recordPath(root, SessionId('fail-soft'))
    await mkdir(blocker, { recursive: true })
    const session = ctx.sessions.create(SessionId('fail-soft'))
    mark(session, ['x'])
    endTurn(session)
    // The failed creation/turn-end writes are fire-and-forget: wait for the
    // warn (the write actually failed), then assert no row landed — the
    // property under test is that a failed write leaves no partial row.
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('turn/end write for "fail-soft" failed'))
    }, { timeout: 5_000 })
    await vi.waitFor(async () => {
      expect(await storedRows(root, session.id)).toBeUndefined()
    }, { timeout: 5_000 })
    // Self-heal: once the blocker clears, the next mandatory point writes.
    await rm(recordPath(root, session.id), { recursive: true })
    mark(session, ['y'])
    endTurn(session)
    await vi.waitFor(async () => {
      expect((await storedRows(root, session.id))?.['cache-test/marks']?.val).toEqual({ marks: ['y'] })
    }, { timeout: 5_000 })
  })
})

describe('SessionProjectionCache listing read', () => {
  it('refuses a checkpoint created for a different inherited cut', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    const id = SessionId('cut-identity')
    await seedRecord(
      root,
      id,
      { 'cache-test/marks': { ver: 1, seq: SessionSeq(1), val: { marks: ['seed'] } } },
      {
        createdAt: 0,
        isSeeded: true,
        inheritedEventCount: SessionLogOffset(2),
      },
    )
    const { cache } = await harness({ root })
    const seededHeader = { ...headerOf(id), isSeeded: true }

    expect(cache.cachedSnapshot(seededHeader, SessionLogOffset(2))?.values['cache-test/marks'])
      .toEqual({ marks: ['seed'] })
    expect(cache.cachedSnapshot(seededHeader, SessionLogOffset(1))).toBeUndefined()
    expect(() => cache.cachedSnapshot(headerOf(id), SessionLogOffset(1)))
      .toThrow('unseeded projection-cache identity inherited event count must be 0')
  })

  it('serves a creation-time checkpoint at the before-first-event cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    await seedRecord(root, 'before-first-event', {
      'cache-test/marks': { ver: 1, seq: -1, val: null },
    })
    const { cache } = await harness({ root })

    expect(cache.cachedSnapshot(headerOf(SessionId('before-first-event')), SessionLogOffset(0)))
      .toEqual({ asOfSeq: -1, values: { 'cache-test/marks': { marks: [] } } })
  })

  it('keeps host-only checkpoint state out of cached wire snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    await seedRecord(root, 'host-state', {
      'cache-test/marks': { ver: 1, seq: SessionSeq(4), val: { marks: ['wire'] } },
      'cache-test/secret': { ver: 1, seq: SessionSeq(4), val: 'private prompt text' },
    })
    const { ctx, cache } = await harness({ root })
    ctx.sessionProjections.register(secretUnit)
    const header = headerOf(SessionId('host-state'))

    expect(cache.cachedSnapshot(header, SessionLogOffset(0))).toEqual({
      asOfSeq: 4,
      values: { 'cache-test/marks': { marks: ['wire'] } },
    })
    expect(JSON.stringify(cache.cachedSnapshot(header, SessionLogOffset(0))))
      .not.toContain('private prompt text')
  })

  it('serves identity-matching rows with the cut watermark and refuses unrelated ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    await seedRecord(root, 'listed', {
      'cache-test/marks': { ver: 1, seq: SessionSeq(4), val: { marks: ['t'] } },
    })
    const { cache } = await harness({ root })
    const id = SessionId('listed')
    // Matching header: values plus the watermark the client seeds under.
    expect(cache.cachedSnapshot(headerOf(id), SessionLogOffset(0)))
      .toEqual({ asOfSeq: 4, values: { 'cache-test/marks': { marks: ['t'] } } })
    // A recreated id (different createdAt): the record is unrelated — no block.
    expect(cache.cachedSnapshot(headerOf(id, 777), SessionLogOffset(0))).toBeUndefined()
    // Unknown id: no block.
    expect(cache.cachedSnapshot(headerOf(SessionId('never-cached')), SessionLogOffset(0)))
      .toBeUndefined()
  })

  it('carries ONE cut across multiple served rows: the lowest watermark wins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    // Equal watermarks: whichever row is visited second cannot lower the cut,
    // so the one-cut fold sees both a lowering and a non-lowering row in
    // every iteration order.
    await seedRecord(root, 'multi-row', {
      'cache-test/marks': { ver: 1, seq: SessionSeq(4), val: { marks: ['a'] } },
      'cache-test/marks3': { ver: 1, seq: SessionSeq(4), val: { marks: ['b'] } },
    })
    const { ctx, cache } = await harness({ root })
    ctx.sessionProjections.register(marks3Unit)
    const block = cache.cachedSnapshot(headerOf(SessionId('multi-row')), SessionLogOffset(0))
    expect(block?.values).toEqual({
      'cache-test/marks': { marks: ['a'] },
      'cache-test/marks3': { marks: ['b'] },
    })
    expect(block?.asOfSeq).toBe(4)
  })

  it('returns undefined when the stored record is version-mismatched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    // A stale version-stamped document is discarded at open: absent record.
    const path = recordPath(root, SessionId('all-stale'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({
      version: projectionCacheDomainSpec.version + 1,
      record: {
        identity: { createdAt: 0, isSeeded: false, inheritedEventCount: 0 },
        rows: { 'cache-test/marks': { ver: 1, seq: 4, val: { marks: ['old'] } } },
      },
    }))
    const { cache } = await harness({ root })
    expect(cache.cachedSnapshot(headerOf(SessionId('all-stale')), SessionLogOffset(0)))
      .toBeUndefined()
  })

  it('serves a pre-lineage record (accepted old version) to an unseeded caller only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    // A document stamped with an accepted older version whose identity
    // predates the lineage fields: absent lineage reads as unseeded.
    const path = recordPath(root, SessionId('pre-lineage'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({
      version: 4,
      record: {
        identity: { createdAt: 0 },
        rows: { 'cache-test/marks': { ver: 1, seq: 4, val: { marks: ['kept'] } } },
      },
    }))
    const { cache } = await harness({ root })
    const id = SessionId('pre-lineage')
    // Unseeded caller: the absent lineage is exactly its identity — served.
    expect(cache.cachedSnapshot(headerOf(id), SessionLogOffset(0)))
      .toEqual({ asOfSeq: 4, values: { 'cache-test/marks': { marks: ['kept'] } } })
    // Seeded caller: the lineage-less record cannot vouch for the cut — refused.
    expect(cache.cachedSnapshot({ ...headerOf(id), isSeeded: true }, SessionLogOffset(2)))
      .toBeUndefined()
  })

  it('returns undefined when every stored row is version-mismatched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    // A current document whose rows all fail the live unit's stateVersion:
    // the listing view is empty, so no block is served.
    await seedRecord(root, 'row-stale', {
      'cache-test/marks': { ver: 99, seq: SessionSeq(4), val: { marks: ['old'] } },
    })
    const { cache } = await harness({ root })
    expect(cache.cachedSnapshot(headerOf(SessionId('row-stale')), SessionLogOffset(0)))
      .toBeUndefined()
  })

  it('binds identity on cwd too: a matching cwd serves, a moved session does not', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    await seedRecord(root, 'homed', {
      'cache-test/marks': { ver: 1, seq: SessionSeq(2), val: { marks: ['w'] } },
    }, {
      createdAt: 0,
      cwd: '/work',
      isSeeded: false,
      inheritedEventCount: SessionLogOffset(0),
    })
    const { cache } = await harness({ root })
    const id = SessionId('homed')
    expect(cache.cachedSnapshot(headerOf(id, 0, '/work'), SessionLogOffset(0))?.values['cache-test/marks'])
      .toEqual({ marks: ['w'] })
    expect(cache.cachedSnapshot(headerOf(id, 0, '/elsewhere'), SessionLogOffset(0))).toBeUndefined()
    expect(cache.cachedSnapshot(headerOf(id, 0), SessionLogOffset(0))).toBeUndefined()
  })

  it('returns undefined for a malformed record document (refold from the log on the caller side)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    const path = recordPath(root, SessionId('malformed'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'not json at all')
    const { cache } = await harness({ root })
    expect(cache.cachedSnapshot(headerOf(SessionId('malformed')), SessionLogOffset(0)))
      .toBeUndefined()
  })
})

describe('SessionProjectionCache cold-read seeding', () => {
  /** One session's event log: turn/start, one mark per group, turn/end. */
  const storedLog = (marks: string[][]): SessionEvent[] => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
    ]
    for (const m of marks) {
      events.push({
        type: 'cache-test/mark',
        seq: SessionSeq(events.length),
        time: events.length,
        data: { marks: m },
      })
    }
    events.push({
      type: 'turn/end',
      seq: SessionSeq(events.length),
      time: events.length,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    return events
  }

  it('hydratePrepared seeds from a matching row and retries from the exact log on a malformed one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    // Records land on disk before the domain opens, so the in-memory table
    // picks them up at init.
    await seedRecord(root, 'prepared-seeded', {
      'cache-test/marks': { ver: 1, seq: SessionSeq(1), val: { marks: ['cached'] } },
    })
    await seedRecord(root, 'prepared-fallback', {
      'cache-test/marks': { ver: 1, seq: SessionSeq(1), val: { marks: 'malformed' } },
    })
    const { cache } = await harness({ root })
    const events = storedLog([['fresh']])

    // A matching row hydrates the prepared Session without a persistence read.
    const seeded = headerOf(SessionId('prepared-seeded'))
    const seededSession = Session.create(seeded.id, events, seeded)
    expect(cache.hydratePrepared(seededSession, events)).toEqual({
      asOfSeq: 2,
      values: { 'cache-test/marks': { marks: ['cached'] } },
    })

    // A malformed row cannot seed the fold; hydration falls back to the
    // exact log so a valid Session stays readable.
    const fallback = headerOf(SessionId('prepared-fallback'))
    const fallbackSession = Session.create(fallback.id, events, fallback)
    expect(cache.hydratePrepared(fallbackSession, events)).toEqual({
      asOfSeq: 2,
      values: { 'cache-test/marks': { marks: ['fresh'] } },
    })

    // No row at all: hydrate from init over the exact log.
    const bare = headerOf(SessionId('prepared-bare'))
    const bareSession = Session.create(bare.id, events, bare)
    expect(cache.hydratePrepared(bareSession, events)).toEqual({
      asOfSeq: 2,
      values: { 'cache-test/marks': { marks: ['fresh'] } },
    })
  })

  it('coldSnapshot traverses the full log but applies only the events after each cached watermark', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    // A cached row covering the prefix through seq 2 (three applies folded).
    await seedRecord(root, 'cold-snap', {
      'cache-test/count': { ver: 1, seq: SessionSeq(2), val: 3 },
    }, {
      createdAt: 9,
      isSeeded: false,
      inheritedEventCount: SessionLogOffset(0),
    })
    const { cache, ctx } = await harness({ root })
    const apply = vi.fn((_state: number, _event: SessionEvent) => 1)
    ctx.sessionProjections.register({
      key: 'cache-test/count',
      stateSchema: z.number().int().nonnegative(),
      init: () => 0,
      apply,
      stateVersion: 1,
    } satisfies ProjectionDefinition<'cache-test/count', number>)
    const meta = headerOf(SessionId('cold-snap'), 9)
    const events = Array.from({ length: 5 }, (_, seq) => ({
      type: 'cache-test/mark', seq: SessionSeq(seq), time: seq, data: { marks: [`m${seq}`] },
    })) as SessionEvent[]
    const snapshot = cache.coldSnapshot(meta, SessionLogOffset(0), events)
    // The full log was traversed, but the fold applied only seqs 3 and 4.
    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls.map(call => call[1].seq)).toEqual([3, 4])
    expect(snapshot.asOfSeq).toBe(4)
    // Host-only unit: folded but not served; the refreshed row is written
    // back (fail-soft, fire-and-forget) once the write lands.
    expect(Object.keys(snapshot.values)).not.toContain('cache-test/count')
    await vi.waitFor(async () => {
      expect((await storedRows(root, meta.id))?.['cache-test/count']?.seq).toBe(4)
    })
    // No cached row yet: the first cold read folds from init over the full
    // log and creates the cache row (the `?? {}` seed path).
    const fresh = headerOf(SessionId('cold-fresh'), 10)
    cache.coldSnapshot(fresh, SessionLogOffset(0), events)
    expect(apply).toHaveBeenCalledTimes(7) // 2 tail + 5 full
    await vi.waitFor(async () => {
      expect((await storedRows(root, fresh.id))?.['cache-test/count']?.seq).toBe(4)
    })
  })

  it('coldSnapshot write-back is fail-soft: a failed durable write logs and never throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root })
    await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(marksUnit())
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    // A directory where the record document must land makes the write-back
    // fail; the cold read itself still succeeds and never throws.
    const meta = headerOf(SessionId('cold-fail'))
    await mkdir(recordPath(root, meta.id), { recursive: true })
    expect(ctx.sessionProjectionCache.coldSnapshot(meta, SessionLogOffset(0), [])).toBeDefined()
    // The failed write-back is fire-and-forget: poll for the warn instead of
    // assuming a fixed settle window (slow runners exceed it).
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('cold-read write-back for "cold-fail" failed'))
    }, { timeout: 5_000 })
  })
})

describe('SessionProjectionCache.cleanup', () => {
  const emptyRows = { 'cache-test/marks': { ver: 1, seq: -1, val: null } } as const

  // Records land on disk before the domain opens (matching the cold-read
  // seeding style above), so the in-memory table picks them up at init.
  async function seededHarness(rows: Record<string, CheckpointRecord['rows']>) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-projcache-'))
    roots.push(root)
    for (const [id, r] of Object.entries(rows)) await seedRecord(root, id, r)
    return harness({ root })
  }

  it('dry run reports stale ids but performs zero deletes', async () => {
    const { cache, root } = await seededHarness({ 'valid-1': emptyRows, 'stale-1': emptyRows })

    const result = await cache.cleanup([SessionId('valid-1')], { dryRun: true })

    expect(result).toEqual({ stale: [SessionId('stale-1')], deleted: [] })
    // A subsequent read still finds the supposedly-stale row.
    expect(await storedRows(root, SessionId('stale-1'))).toBeDefined()
    expect(await storedRows(root, SessionId('valid-1'))).toBeDefined()
  })

  it('apply mode removes exactly the stale rows and leaves valid ids intact', async () => {
    const { cache, root } = await seededHarness({ 'valid-1': emptyRows, 'stale-1': emptyRows, 'stale-2': emptyRows })

    const result = await cache.cleanup([SessionId('valid-1')], { dryRun: false })

    expect(result.stale).toEqual([SessionId('stale-1'), SessionId('stale-2')])
    expect([...result.deleted].sort()).toEqual([SessionId('stale-1'), SessionId('stale-2')])
    expect(await storedRows(root, SessionId('stale-1'))).toBeUndefined()
    expect(await storedRows(root, SessionId('stale-2'))).toBeUndefined()
    expect(await storedRows(root, SessionId('valid-1'))).toBeDefined()
  })

  it('returns stale ids sorted regardless of insertion order', async () => {
    const { cache } = await seededHarness({
      'stale-charlie': emptyRows,
      'stale-alpha': emptyRows,
      'stale-bravo': emptyRows,
    })

    const result = await cache.cleanup([], { dryRun: true })

    expect(result.stale).toEqual([SessionId('stale-alpha'), SessionId('stale-bravo'), SessionId('stale-charlie')])
  })

  it('an already-aborted signal rejects before doing any work, even for a dry run', async () => {
    const { cache, root } = await seededHarness({ 'stale-1': emptyRows })
    const controller = new AbortController()
    controller.abort()

    await expect(cache.cleanup([], { dryRun: true, signal: controller.signal })).rejects.toThrow()
    // Not a successful dry run: the stale row was never even inspected/removed.
    expect(await storedRows(root, SessionId('stale-1'))).toBeDefined()
  })

  it('an empty validIds set treats every cached row as stale', async () => {
    const { cache, root } = await seededHarness({ 'stale-1': emptyRows, 'stale-2': emptyRows })

    const result = await cache.cleanup([], { dryRun: false })

    expect(result.stale).toEqual([SessionId('stale-1'), SessionId('stale-2')])
    expect(result.deleted).toEqual([SessionId('stale-1'), SessionId('stale-2')])
    expect(await storedRows(root, SessionId('stale-1'))).toBeUndefined()
    expect(await storedRows(root, SessionId('stale-2'))).toBeUndefined()
  })

  it('a signal aborted after the first delete stops before the next one', async () => {
    const { cache, root } = await seededHarness({ 'stale-a': emptyRows, 'stale-b': emptyRows })
    const controller = new AbortController()
    // Reach the private table to hook the real delete. Cast through `unknown`
    // rather than `any` so the shape is stated explicitly and nothing else on
    // `cache` loses its type.
    const table = (cache as unknown as { table: KvTable<SessionId, CheckpointRecord> }).table
    const originalDelete = table.delete.bind(table)
    const deleteSpy = vi.spyOn(table, 'delete').mockImplementation(async (id: SessionId) => {
      const result = await originalDelete(id)
      controller.abort() // fires after the first delete lands, before the second is attempted
      return result
    })

    await expect(cache.cleanup([], { dryRun: false, signal: controller.signal })).rejects.toThrow()

    expect(deleteSpy).toHaveBeenCalledTimes(1)
    expect(await storedRows(root, SessionId('stale-a'))).toBeUndefined() // deleted before the abort was observed
    expect(await storedRows(root, SessionId('stale-b'))).toBeDefined() // never reached
  })

  it('a signal aborted after the entry guard but before the first delete rejects with zero deletes performed', async () => {
    const { cache, root } = await seededHarness({ 'stale-a': emptyRows, 'stale-b': emptyRows })
    const controller = new AbortController()
    const table = (cache as unknown as { table: KvTable<SessionId, CheckpointRecord> }).table
    const originalKeys = table.keys.bind(table)
    const deleteSpy = vi.spyOn(table, 'delete')
    // `keys()` runs synchronously right after the top-level throwIfAborted (the
    // entry guard) and right before `stale` is computed and the loop's own
    // throwIfAborted on its first iteration — the only sync window between
    // the two checks.
    vi.spyOn(table, 'keys').mockImplementation(() => {
      controller.abort()
      return originalKeys()
    })

    await expect(cache.cleanup([], { dryRun: false, signal: controller.signal })).rejects.toThrow()

    expect(deleteSpy).not.toHaveBeenCalled()
    expect(await storedRows(root, SessionId('stale-a'))).toBeDefined() // no delete actually landed
    expect(await storedRows(root, SessionId('stale-b'))).toBeDefined()
  })

  it('a stale id whose delete returns false is reported stale but not deleted', async () => {
    const { cache, root } = await seededHarness({ 'stale-a': emptyRows, 'stale-b': emptyRows })
    const table = (cache as unknown as { table: KvTable<SessionId, CheckpointRecord> }).table
    const originalDelete = table.delete.bind(table)
    vi.spyOn(table, 'delete').mockImplementation(async (id: SessionId) => {
      if (id === SessionId('stale-a')) return false
      return originalDelete(id)
    })

    const result = await cache.cleanup([], { dryRun: false })

    expect(result.stale).toEqual([SessionId('stale-a'), SessionId('stale-b')])
    expect(result.deleted).toEqual([SessionId('stale-b')])
    expect(await storedRows(root, SessionId('stale-b'))).toBeUndefined()
  })

  // `cleanup` trusts `validIds` completely and cannot tell a partial listing
  // from a real one, so a caller whose listing fails must fail closed rather
  // than call cleanup with what it managed to read.
  it('a validIds set missing a live id deletes that live row, so a caller must never pass a partial listing', async () => {
    const { cache, root } = await seededHarness({ 'live-1': emptyRows, 'live-2': emptyRows, 'stale-1': emptyRows })

    const result = await cache.cleanup([SessionId('live-1')], { dryRun: false })

    expect(result.stale).toEqual([SessionId('live-2'), SessionId('stale-1')])
    expect(result.deleted).toEqual([SessionId('live-2'), SessionId('stale-1')])
    expect(await storedRows(root, SessionId('live-2'))).toBeUndefined()
    expect(await storedRows(root, SessionId('live-1'))).toBeDefined()
  })

  // `cleanup` itself no longer lists persistence (it takes `validIds` as a
  // parameter); the fail-closed guarantee the old self-listing version had
  // "by construction" now depends entirely on the caller awaiting its own
  // listing before calling cleanup. This composition is what a real caller
  // must perform, and both cases below route through it so the failure case
  // cannot pass merely because the composition never actually works.
  async function cleanupViaPersistenceListing(
    ctx: Context,
    cache: SessionProjectionCache,
    signal?: AbortSignal,
  ): Promise<{ stale: SessionId[]; deleted: SessionId[] }> {
    const ids = (await ctx.sessionPersistence.list(signal)).map(header => header.id)
    return cache.cleanup(ids, { dryRun: false, ...signal === undefined ? {} : { signal } })
  }

  // A representative session-log document, seeded so the byte assertions below
  // are not vacuous. The cache domain and SessionStore share this storage root,
  // so a cleanup that reached past its own records would surface here.
  async function seedSessionLog(root: string, id: string): Promise<void> {
    const path = join(root, 'session_log', 'sessions', `${id}.jsonl`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ seq: 0, kind: 'representative-log-bytes' })}\n`)
  }

  it('a rejecting persistence listing aborts the whole cleanup composition, deleting nothing', async () => {
    const { ctx, cache, root } = await seededHarness({ 'live-1': emptyRows, 'stale-1': emptyRows })
    await seedSessionLog(root, 'live-1')
    await seedSessionLog(root, 'stale-1')
    ctx.provide('sessionPersistence', {
      list: async () => { throw new Error('listing failed') },
    } as never)
    const table = (cache as unknown as { table: KvTable<SessionId, CheckpointRecord> }).table
    const deleteSpy = vi.spyOn(table, 'delete')
    const cleanupSpy = vi.spyOn(cache, 'cleanup')
    const before = await treeDigest(root)

    await expect(cleanupViaPersistenceListing(ctx, cache)).rejects.toThrow('listing failed')

    // Zero cleanup calls, not merely zero deletes: the composition has to
    // reject before it reaches the API at all.
    expect(cleanupSpy).not.toHaveBeenCalled()
    expect(deleteSpy).not.toHaveBeenCalled()
    // Byte-for-byte rather than merely present: every file under the storage
    // root is unchanged, cache records and session-log bytes alike.
    expect(await treeDigest(root)).toEqual(before)
    expect(await storedRows(root, SessionId('live-1'))).toBeDefined()
    expect(await storedRows(root, SessionId('stale-1'))).toBeDefined()
  })

  it('a resolving persistence listing performs the expected cleanup (positive control)', async () => {
    const { ctx, cache, root } = await seededHarness({ 'live-1': emptyRows, 'stale-1': emptyRows })
    await seedSessionLog(root, 'live-1')
    await seedSessionLog(root, 'stale-1')
    ctx.provide('sessionPersistence', {
      list: async () => [headerOf(SessionId('live-1'))],
    } as never)
    const cleanupSpy = vi.spyOn(cache, 'cleanup')
    const before = await treeDigest(root)

    const result = await cleanupViaPersistenceListing(ctx, cache)

    // Both instruments register a real effect here, so the failure case above
    // cannot pass merely because the spy or the digest never works.
    expect(cleanupSpy).toHaveBeenCalledTimes(1)
    expect(await treeDigest(root)).not.toEqual(before)
    expect(result.deleted).toEqual([SessionId('stale-1')])
    expect(await storedRows(root, SessionId('stale-1'))).toBeUndefined()
    expect(await storedRows(root, SessionId('live-1'))).toBeDefined()
  })
})
