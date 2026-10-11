// Deterministic synthetic workspace: N TypeScript-looking modules of roughly
// fixed size. Generated, not copied from the harness, so every branch under
// test reads byte-identical input and the fixers' edits cannot change the load.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

const WORDS = ['ledger', 'route', 'batch', 'cursor', 'window', 'budget', 'shard', 'token', 'frame', 'queue',
  'lease', 'probe', 'quota', 'epoch', 'delta', 'index', 'region', 'fence', 'slot', 'span']

/** @returns {string[]} relative file paths written. */
export function writeFixture(dir, { files = 40, bytesPerFile = 12000, seed = 7 } = {}) {
  const r = rng(seed)
  const pick = () => WORDS[Math.floor(r() * WORDS.length)]
  const out = []
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (let f = 0; f < files; f++) {
    const name = `src/module_${String(f).padStart(3, '0')}_${pick()}.ts`
    let text = `// Module ${f}: ${pick()} ${pick()} handling.\n`
    let fn = 0
    while (text.length < bytesPerFile) {
      const a = pick(), b = pick(), n = Math.floor(r() * 900) + 100
      text += `\nexport function ${a}${b[0].toUpperCase()}${b.slice(1)}${fn++}(${a}: number, ${b}: string): number {\n` +
        `  const limit = ${n}\n  if (${a} > limit) return ${a} % limit\n` +
        `  // ${pick()} ${pick()} ${pick()} before ${pick()}\n  return ${b}.length * ${Math.floor(r() * 50) + 1}\n}\n`
    }
    writeFileSync(join(dir, name), text)
    out.push(name)
  }
  writeFileSync(join(dir, 'NOTES.md'), '# Notes\n')
  return out
}
