import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import { meta, oneTurnLog } from '../../session-persistence/tests/contract.ts'
import { sql } from '../src/sql.ts'
import { testSql } from './test-sql.ts'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function freshDbPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-sqlite-delete-'))
  directories.push(directory)
  return join(directory, 'sessions.db')
}

interface Mounted {
  readonly ctx: Context
  dispose(): Promise<void>
}

async function mount(path: string): Promise<Mounted> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(SessionPersistenceSqlite, { path })
  return { ctx, dispose: async () => { await fiber.dispose() } }
}

/** Read committed rows through a second connection, after the writer released them. */
function withProbe<T>(path: string, read: (probe: DatabaseSync) => T): T {
  const probe = new DatabaseSync(path)
  try {
    return read(probe)
  } finally {
    probe.close()
  }
}

function sessionRow(probe: DatabaseSync, id: SessionId): unknown {
  return probe.prepare(sql('select-session')).get(id)
}

function eventRows(probe: DatabaseSync, id: SessionId): unknown[] {
  return probe.prepare(testSql('select-event-rows')).all(id)
}

async function seed(ctx: Context, header: SessionHeader): Promise<void> {
  await ctx.sessionPersistence.create(header)
  await ctx.sessionPersistence.append(header.id, oneTurnLog())
}

describe('SQLite session deletion', () => {
  it('declares deletion support', async () => {
    const mounted = await mount(await freshDbPath())
    try {
      expect(mounted.ctx.sessionPersistence.supportsDeletion).toBe(true)
    } finally {
      await mounted.dispose()
    }
  })

  it('removes every row of an idle session', async () => {
    const path = await freshDbPath()
    const mounted = await mount(path)
    const m = meta('sqlite-delete-idle', '/work')
    try {
      await seed(mounted.ctx, m)
      expect(withProbe(path, probe => eventRows(probe, m.id).length)).toBeGreaterThan(0)

      await mounted.ctx.sessionPersistence.delete(m.id)

      expect((await mounted.ctx.sessionPersistence.list()).map(header => header.id)).not.toContain(m.id)
      expect((await mounted.ctx.sessionPersistence.listSnapshots()).map(snapshot => snapshot.header.id))
        .not.toContain(m.id)
    } finally {
      await mounted.dispose()
    }
    // The events rows go with the metadata row through ON DELETE CASCADE; this
    // fails if the foreign_keys pragma or the schema's cascade ever stops applying.
    withProbe(path, (probe) => {
      expect(sessionRow(probe, m.id)).toBeUndefined()
      expect(eventRows(probe, m.id)).toEqual([])
    })
  })

  it('leaves other sessions untouched', async () => {
    const path = await freshDbPath()
    const mounted = await mount(path)
    const target = meta('sqlite-delete-target', '/work')
    const bystander = meta('sqlite-delete-bystander', '/work')
    try {
      await seed(mounted.ctx, target)
      await seed(mounted.ctx, bystander)

      await mounted.ctx.sessionPersistence.delete(target.id)

      expect((await mounted.ctx.sessionPersistence.load(bystander.id)).events)
        .toEqual(oneTurnLog())
    } finally {
      await mounted.dispose()
    }
  })

  it('treats an unknown id as a successful no-op', async () => {
    const mounted = await mount(await freshDbPath())
    try {
      await expect(mounted.ctx.sessionPersistence.delete(SessionId('sqlite-delete-absent')))
        .resolves.toBeUndefined()
    } finally {
      await mounted.dispose()
    }
  })

  it('does not cascade to descendant sessions', async () => {
    const path = await freshDbPath()
    const mounted = await mount(path)
    const parent = meta('sqlite-delete-ancestor', '/work')
    const child: SessionHeader = { ...meta('sqlite-delete-descendant', '/work'), parentSession: parent.id }
    try {
      await seed(mounted.ctx, parent)
      await seed(mounted.ctx, child)

      await mounted.ctx.sessionPersistence.delete(parent.id)

      const listed = await mounted.ctx.sessionPersistence.list()
      expect(listed.map(header => header.id)).not.toContain(parent.id)
      // The descendant keeps its rows and its now-dangling parentSession value.
      expect(listed.find(header => header.id === child.id)?.parentSession).toBe(parent.id)
      expect((await mounted.ctx.sessionPersistence.load(child.id)).events).toEqual(oneTurnLog())
    } finally {
      await mounted.dispose()
    }
    expect(withProbe(path, probe => eventRows(probe, child.id).length)).toBeGreaterThan(0)
  })

  it('refuses deletion while a live session owns the stored prefix', async () => {
    const path = await freshDbPath()
    const m = meta('sqlite-delete-owned', '/work')
    const log = oneTurnLog()
    const writer = await mount(path)
    await seed(writer.ctx, m)
    // Drop coordinator tracking while the rows remain, so the next mount adopts
    // the stored prefix for a live session instead of claiming ownerless state.
    await writer.dispose()

    const owned = await mount(path)
    let session!: Session
    await owned.ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create(m.id, { seed: log, meta: { cwd: '/work' } })
    }, { inject: ['sessions'] }))
    await owned.ctx.sessions.flush(session)

    try {
      await expect(owned.ctx.sessionPersistence.delete(m.id)).rejects.toThrow(/persistence work is pending/)
      expect((await owned.ctx.sessionPersistence.list()).map(header => header.id)).toContain(m.id)
    } finally {
      await owned.dispose()
    }
    expect(withProbe(path, probe => eventRows(probe, m.id).length)).toBeGreaterThan(0)
  })
})
