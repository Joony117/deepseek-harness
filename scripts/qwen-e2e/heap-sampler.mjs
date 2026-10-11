// Loaded into the dsh process via NODE_OPTIONS=--import. Samples the V8 heap and
// GC pause time so dsh's own memory (#4722) is measured apart from the model
// server's. Child processes inherit NODE_OPTIONS, so only the dsh CLI samples.
import { appendFileSync } from 'node:fs'
import { PerformanceObserver } from 'node:perf_hooks'

const out = process.env.DSH_E2E_HEAP_LOG
if (out && /apps[\\/]cli[\\/]lib[\\/]bin\.js$/.test(process.argv[1] ?? '')) {
  const everyMs = Number(process.env.DSH_E2E_HEAP_EVERY_MS ?? 5000)
  let gcMs = 0
  let gcCount = 0
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) { gcMs += e.duration; gcCount++ }
  }).observe({ entryTypes: ['gc'] })
  const sample = () => {
    const m = process.memoryUsage()
    appendFileSync(out, JSON.stringify({
      t: Date.now(), pid: process.pid,
      heapUsed: m.heapUsed, heapTotal: m.heapTotal, rss: m.rss, external: m.external,
      gcMs: Math.round(gcMs), gcCount,
    }) + '\n')
    gcMs = 0
    gcCount = 0
  }
  sample()
  setInterval(sample, everyMs).unref()
  process.on('exit', sample)
}
