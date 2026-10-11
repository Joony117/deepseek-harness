// Where do two saved request bodies stop sharing a prefix?
//   node scripts/qwen-e2e/prefix-diff.mjs <runDir>/bodies <seqA> <seqB>
// Compares in template order: tools, then messages one by one, and prints the
// first differing message with a snippet around the first differing character.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { commonPrefix } from './proxy.mjs'

export function diverge(a, b) {
  const ta = JSON.stringify(a.tools ?? []), tb = JSON.stringify(b.tools ?? [])
  if (ta !== tb) return { where: 'tools', at: commonPrefix(ta, tb), a: ta, b: tb }
  const ma = a.messages ?? [], mb = b.messages ?? []
  for (let i = 0; i < Math.min(ma.length, mb.length); i++) {
    const x = JSON.stringify(ma[i]), y = JSON.stringify(mb[i])
    if (x !== y) return { where: `message ${i} (${ma[i].role} vs ${mb[i].role})`, index: i, at: commonPrefix(x, y), a: x, b: y }
  }
  return { where: ma.length === mb.length ? 'identical' : `one is a prefix (${ma.length} vs ${mb.length} messages)` }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const [dir, sa, sb] = process.argv.slice(2)
  const load = s => JSON.parse(readFileSync(join(dir, `${s}.json`), 'utf8'))
  const d = diverge(load(sa), load(sb))
  console.log(`first divergence: ${d.where}${d.at !== undefined ? ` at char ${d.at}` : ''}`)
  if (d.a) {
    const from = Math.max(0, d.at - 200)
    console.log(`--- ${sa}: …${d.a.slice(from, d.at + 300)}…`)
    console.log(`--- ${sb}: …${d.b.slice(from, d.at + 300)}…`)
  }
}
