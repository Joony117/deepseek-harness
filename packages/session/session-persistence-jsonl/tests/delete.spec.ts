/**
 * Durable session deletion on the rc.3 handle seam.
 *
 * Deletion is a fork addition: upstream has no deletion API. At rc.1 it lived
 * on the persistence coordinator; rc.3 deleted the coordinator, so the backend
 * owns it and leans on the seam's own single-writer claim for admission. These
 * pin the guarantees FORK.md names: refuse while claimed, fence create and
 * write-open for the whole removal, verify every stored header before anything
 * is removed ("unparseable" is not "anonymous", "no first line" is not "no
 * bytes"), refuse a link-shaped directory, and remove the highest generation
 * last so a partial failure can never roll a session back to older history.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionDeleteConflictError, SessionPersistenceNotFoundError,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { JsonlCompression } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogPath, logPath, projectDir, sessionDir } from '../src/format.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../src/zstd.ts'
import { meta, oneTurnLog, releasedV1OneTurnLog } from '../../session-persistence/tests/contract.ts'

/** Records removal order and can hold a delete between its claim and its removal. */
const fsHooks = vi.hoisted(() => ({
  removed: [] as string[],
  lstatGate: undefined as Promise<void> | undefined,
  lstatReached: undefined as (() => void) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      fsHooks.removed.push(String(args[0]))
      return actual.rm(...args)
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      fsHooks.lstatReached?.()
      if (fsHooks.lstatGate !== undefined) await fsHooks.lstatGate
      return actual.lstat(...args)
    },
  }
})

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  fsHooks.removed.length = 0
  fsHooks.lstatGate = undefined
  fsHooks.lstatReached = undefined
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-delete-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** One mounted JSONL backend over `root`. */
async function mount(root: string, compression: JsonlCompression = 'none'): Promise<SessionPersistence> {
  const ctx = new Context()
  const fiber = await ctx.plugin(JsonlSessionPersistence, { root, compression })
  cleanups.push(() => fiber.dispose())
  return ctx.sessionPersistence
}

/** Materialize one stored session with a complete turn, closing its writer. */
async function store(persistence: SessionPersistence, header: SessionHeader): Promise<void> {
  const handle = await persistence.create(header)
  try {
    await handle.append(oneTurnLog())
  } finally {
    await handle.close()
  }
}

async function listedIds(persistence: SessionPersistence): Promise<string[]> {
  return (await persistence.list()).map(snapshot => snapshot.header.id)
}

/** Rewrite only a raw stored header line, preserving every event byte below it. */
async function rewriteHeader(path: string, update: (header: Record<string, unknown>) => void): Promise<void> {
  const lines = (await readFile(path, 'utf8')).split('\n')
  const header = JSON.parse(lines[0] as string) as Record<string, unknown>
  update(header)
  lines[0] = JSON.stringify(header)
  await writeFile(path, lines.join('\n'))
}

/** Rewrite only the independently compressed header frame of a zstd log. */
async function rewriteZstdHeader(path: string, update: (header: Record<string, unknown>) => void): Promise<void> {
  const buffer = await readFile(path)
  const first = scanZstdFrames(buffer, 1).frames[0]
  expect(first).toBeDefined()
  const decoded = await decompressZstdFrame(buffer.subarray(first!.start, first!.end))
  const header = JSON.parse(decoded.toString('utf8').split('\n')[0] as string) as Record<string, unknown>
  update(header)
  await writeFile(path, Buffer.concat([
    await compressZstdFrame(`${JSON.stringify(header)}\n`),
    buffer.subarray(first!.end),
  ]))
}

/** A released v0 header line for `header`, the oldest historical generation. */
function releasedV0HeaderLine(header: SessionHeader): string {
  return JSON.stringify({
    type: 'session',
    version: 0,
    id: header.id,
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    delegationDepth: 0,
  })
}

/** A supported historical turn with its first surface inside the step. */
function migrationOneTurnLog(): SessionEvent[] {
  const [turn, user, step, ...tail] = releasedV1OneTurnLog()
  return [turn!, { ...step!, time: 2 }, { ...user!, time: 3 }, ...tail]
    .map((event, seq) => ({ ...event, seq: SessionSeq(seq) }))
}

async function refusal(promise: Promise<unknown>): Promise<SessionDeleteConflictError> {
  const error = await promise.then(() => undefined, (rejected: unknown) => rejected)
  expect(error).toBeInstanceOf(SessionDeleteConflictError)
  return error as SessionDeleteConflictError
}

describe('JSONL durable session deletion', () => {
  it('declares the capability and removes the session directory, not its project', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const header = meta('delete-materialized', '/work')
    await store(persistence, header)
    expect(persistence.supportsDeletion).toBe(true)

    await persistence.delete(header.id)

    await expect(stat(sessionDir(root, header.cwd, header.id))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(projectDir(root, header.cwd))).isDirectory()).toBe(true)
    expect(await listedIds(persistence)).not.toContain(header.id)
    expect(await persistence.stat(header.id)).toBeUndefined()
    await expect(persistence.open(header.id, 'read')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
  })

  it('treats absence as the postcondition, so a retried or never-stored delete succeeds', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const header = meta('delete-twice', '/work')
    await store(persistence, header)

    await persistence.delete(header.id)
    await persistence.delete(header.id)
    await persistence.delete(SessionId('never-stored'))
  })

  it('refuses while a write handle owns the id, then deletes once it closes', async () => {
    // rc.1 queued a backend delete behind an in-flight append on the
    // coordinator's per-id chain. rc.3 has no append outside a live write
    // handle, so the claim itself is the refusal: the Host disposes its own
    // lifecycle first, and Agent disposal awaits the handle's drain.
    const root = await freshRoot()
    const persistence = await mount(root)
    const header = meta('delete-live', '/work')
    await store(persistence, header)
    const writer = await persistence.open(header.id, 'write')
    const path = logPath(root, header.cwd, header.id, 'none')
    const before = await readFile(path)

    expect((await refusal(persistence.delete(header.id))).conflict).toBe('live')
    expect(await readFile(path)).toEqual(before)

    await writer.close()
    await persistence.delete(header.id)
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a created session that has not materialized yet', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const creator = await persistence.create(meta('delete-pending', '/work'))

    expect((await refusal(persistence.delete(creator.id))).conflict).toBe('live')

    await creator.close()
  })

  it('refuses while a read handle is open, then deletes once it closes', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const header = meta('delete-reading', '/work')
    await store(persistence, header)
    const reader = await persistence.open(header.id, 'read')

    expect((await refusal(persistence.delete(header.id))).conflict).toBe('loading')

    await reader.close()
    await persistence.delete(header.id)
  })

  it('refuses while another backend instance holds the kernel write lock', async () => {
    // Stands in for another process: the second instance has no in-process
    // claim on the id, so only the kernel lease can refuse it.
    const root = await freshRoot()
    const first = await mount(root)
    const second = await mount(root)
    const header = meta('delete-cross-instance', '/work')
    await store(first, header)
    const writer = await first.open(header.id, 'write')

    expect((await refusal(second.delete(header.id))).conflict).toBe('live')
    expect(await listedIds(second)).toContain(header.id)

    await writer.close()
    await second.delete(header.id)
  })

  it('fences create and write-open for the whole removal, and admits a fresh create after', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const header = meta('delete-fenced', '/work')
    await store(persistence, header)
    let release!: () => void
    fsHooks.lstatGate = new Promise((resolve) => { release = resolve })
    const reached = new Promise<void>((resolve) => { fsHooks.lstatReached = resolve })

    const deletion = persistence.delete(header.id)
    await reached
    await expect(persistence.create(header)).rejects.toBeInstanceOf(SessionAlreadyExistsError)
    await expect(persistence.open(header.id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    release()
    await deletion

    // Deletion retires one incarnation, not the name.
    await store(persistence, header)
    expect(await listedIds(persistence)).toContain(header.id)
  })

  it('refuses when the stored header names another session, leaving the bytes untouched', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const header = meta('delete-identity-a', '/same')
    await store(persistence, header)
    const path = logPath(root, header.cwd, header.id, 'none')
    await rewriteHeader(path, (line) => { line.id = 'delete-identity-b' })
    const before = await readFile(path)

    await expect(persistence.delete(header.id))
      .rejects.toThrow(/requested id "delete-identity-a" does not match header id "delete-identity-b"/)
    expect(await readFile(path)).toEqual(before)
  })

  it('refuses when a header naming another session cannot be parsed', async () => {
    // One invalid field unrelated to identity rejects the whole line, so the
    // id it states is never compared: unparseable must not read as anonymous.
    const root = await freshRoot()
    const persistence = await mount(root)
    const header = meta('delete-unparseable-a', '/same')
    await store(persistence, header)
    const path = logPath(root, header.cwd, header.id, 'none')
    await rewriteHeader(path, (line) => {
      line.id = 'delete-unparseable-b'
      line.delegationDepth = -1
    })
    const before = await readFile(path)

    await expect(persistence.delete(header.id)).rejects.toThrow(/cannot be parsed/)
    expect(await readFile(path)).toEqual(before)
  })

  it('refuses when a complete header naming another session lost its newline', async () => {
    // "No first line" answers exactly as an empty file does; only a stat can
    // tell a torn identity claim from no bytes at all.
    const root = await freshRoot()
    const persistence = await mount(root)
    const header = meta('delete-torn-a', '/same')
    await store(persistence, header)
    const path = logPath(root, header.cwd, header.id, 'none')
    await writeFile(path, JSON.stringify(meta('delete-torn-b', '/same')))
    const before = await readFile(path)
    expect(before.includes(0x0a)).toBe(false)

    await expect(persistence.delete(header.id)).rejects.toThrow(/cannot be parsed/)
    expect(await readFile(path)).toEqual(before)
  })

  it('still deletes an artifact with no header bytes at all', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const header = meta('delete-empty', '/work')
    const path = logPath(root, header.cwd, header.id, 'none')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '')

    await persistence.delete(header.id)

    await expect(stat(dirname(path))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a session directory that is a link rather than a real directory', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const header = meta('delete-linked', '/work')
    await store(persistence, header)
    const real = sessionDir(root, header.cwd, header.id)
    const moved = join(root, 'moved-out-of-the-way')
    await rename(real, moved)
    await symlink(moved, real, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(persistence.delete(header.id)).rejects.toThrow(/is a link rather than a real directory/)

    expect((await stat(moved)).isDirectory()).toBe(true)
    expect((await readdir(moved)).length).toBeGreaterThan(0)
  })

  it('refuses a generation file that is a link, before reading through it', async (context) => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const header = meta('delete-linked-generation', '/work')
    await store(persistence, header)
    const current = logPath(root, header.cwd, header.id, 'none')
    // The target sits outside the root and its header really names this id,
    // so only the entry's own shape can refuse it.
    const outside = join(await freshRoot(), 'elsewhere.jsonl')
    await rename(current, outside)
    try {
      await symlink(outside, current, 'file')
    } catch (error: unknown) {
      // Windows without the symlink privilege cannot make the fixture.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return context.skip()
      throw error
    }

    await expect(persistence.delete(header.id)).rejects.toThrow(/is not a regular file/)

    expect((await stat(outside)).isFile()).toBe(true)
    expect((await readdir(dirname(current))).length).toBeGreaterThan(0)
  })

  it('removes every generation, the current one last', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const header = meta('delete-generations', '/work')
    const source = generationLogPath(root, header.cwd, header.id, 0, 'none')
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, `${releasedV0HeaderLine(header)}\n${migrationOneTurnLog().map(event => JSON.stringify(event)).join('\n')}\n`)
    // A write open publishes the current successor and keeps the v0 source.
    await (await persistence.open(header.id, 'write')).close()
    const current = logPath(root, header.cwd, header.id, 'none')
    expect((await stat(current)).isFile()).toBe(true)
    expect((await stat(source)).isFile()).toBe(true)
    fsHooks.removed.length = 0

    await persistence.delete(header.id)

    const dir = sessionDir(root, header.cwd, header.id)
    expect(fsHooks.removed).toEqual([source, current, dir])
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses when an older generation names another session, even with a valid current log', async () => {
    const root = await freshRoot()
    const persistence = await mount(root)
    const header = meta('delete-foreign-history', '/work')
    await store(persistence, header)
    const foreign = generationLogPath(root, header.cwd, header.id, 0, 'none')
    await writeFile(foreign, `${releasedV0HeaderLine(meta('someone-else', '/work'))}\n`)
    const before = await readFile(foreign)

    await expect(persistence.delete(header.id)).rejects.toThrow(/does not match header id "someone-else"/)
    expect(await readFile(foreign)).toEqual(before)
    expect((await stat(logPath(root, header.cwd, header.id, 'none'))).isFile()).toBe(true)
  })
})

describe('JSONL durable session deletion: Zstandard', () => {
  // The deployed harness runs the zstd side of the header read.

  it('deletes a materialized zstd session directory', async () => {
    const root = await freshRoot()
    const persistence = await mount(root, 'zstd')
    const header = meta('zstd-delete', '/work')
    await store(persistence, header)

    await persistence.delete(header.id)

    await expect(stat(sessionDir(root, header.cwd, header.id))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses when the zstd header names another session', async () => {
    const root = await freshRoot()
    const persistence = await mount(root, 'zstd')
    const header = meta('zstd-identity-a', '/same')
    await store(persistence, header)
    const path = logPath(root, header.cwd, header.id, 'zstd')
    await rewriteZstdHeader(path, (line) => { line.id = 'zstd-identity-b' })
    const before = await readFile(path)

    await expect(persistence.delete(header.id))
      .rejects.toThrow(/requested id "zstd-identity-a" does not match header id "zstd-identity-b"/)
    expect(await readFile(path)).toEqual(before)
  })

  it('refuses when a zstd header naming another session cannot be parsed', async () => {
    const root = await freshRoot()
    const persistence = await mount(root, 'zstd')
    const header = meta('zstd-unparseable-a', '/same')
    await store(persistence, header)
    const path = logPath(root, header.cwd, header.id, 'zstd')
    await rewriteZstdHeader(path, (line) => {
      line.id = 'zstd-unparseable-b'
      line.delegationDepth = -1
    })
    const before = await readFile(path)

    await expect(persistence.delete(header.id)).rejects.toThrow(/cannot be parsed/)
    expect(await readFile(path)).toEqual(before)
  })

  it('refuses when the first zstd frame is present but truncated', async () => {
    const root = await freshRoot()
    const persistence = await mount(root, 'zstd')
    const header = meta('zstd-torn', '/work')
    await store(persistence, header)
    const path = logPath(root, header.cwd, header.id, 'zstd')
    const whole = await readFile(path)
    const first = scanZstdFrames(whole, 1).frames[0]
    expect(first).toBeDefined()
    // Cut INSIDE the header frame: a cut past frame 0 leaves a decodable header.
    const torn = whole.subarray(0, first!.end - 2)
    await writeFile(path, torn)
    expect(scanZstdFrames(torn, 1).frames[0]).toBeUndefined()

    await expect(persistence.delete(header.id)).rejects.toThrow(/cannot be parsed/)
    expect(await readFile(path)).toEqual(torn)
  })
})
