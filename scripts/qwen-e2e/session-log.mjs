// Read a dsh session log (session.v<N>.jsonl or .jsonl.zstd) into events.
// The zstd file is a run of independent frames; node's decoder stops after
// the first, so frames are split structurally (same walk as
// packages/session/session-persistence-jsonl/src/zstd.ts) and decoded one by one.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = 0xFD2FB528

function frames(buf) {
  const out = []
  let o = 0
  while (o + 5 <= buf.length) {
    const start = o
    if (buf.readUInt32LE(o) !== MAGIC) throw new Error(`bad zstd magic at ${o}`)
    o += 4
    const d = buf.readUInt8(o++)
    const fcs = d >>> 6, single = (d & 0x20) !== 0, checksum = (d & 0x04) !== 0, dict = d & 3
    o += (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (fcs === 0 ? (single ? 1 : 0) : 1 << fcs)
    for (;;) {
      if (o + 3 > buf.length) return out // torn tail: ignore, as the backend would repair it
      const h = buf.readUIntLE(o, 3)
      o += 3 + (((h >>> 1) & 3) === 1 ? 1 : h >>> 3)
      if (h & 1) break
    }
    if (checksum) o += 4
    if (o > buf.length) return out
    out.push(buf.subarray(start, o))
  }
  return out
}

/** @returns {object[]} every JSON line, header first. */
export function readSessionLog(file) {
  const buf = readFileSync(file)
  const text = file.endsWith('.zstd')
    ? frames(buf).map(f => zstdDecompressSync(f).toString('utf8')).join('')
    : buf.toString('utf8')
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l))
}

/** Newest-generation log file in one session directory. */
export function latestLog(sessionDir) {
  const logs = readdirSync(sessionDir).filter(n => /^session\.v\d+\.jsonl(\.zstd)?$/.test(n))
  logs.sort((a, b) => Number(b.match(/v(\d+)/)[1]) - Number(a.match(/v(\d+)/)[1]))
  if (!logs.length) throw new Error(`no session log in ${sessionDir}`)
  return join(sessionDir, logs[0])
}

/** Find a session directory by id under a sessions root (any project). */
export function findSessionDir(root, id) {
  for (const project of readdirSync(root)) {
    const dir = join(root, project, id)
    try { if (statSync(dir).isDirectory()) return dir } catch { /* not in this project: keep looking */ }
  }
  throw new Error(`session ${id} not found under ${root}`)
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const events = readSessionLog(process.argv[2])
  const counts = {}
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1
  console.log(events.length, counts)
}
