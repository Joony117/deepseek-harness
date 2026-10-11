// Turn one run's raw files into the numbers the audit's checks ask for.
// Re-run on a saved run dir:  node scripts/qwen-e2e/analyze.mjs <runDir>
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSessionLog } from './session-log.mjs'

const jsonl = f => existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const pct = (xs, p) => {
  if (!xs.length) return null
  const s = [...xs].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}
const sum = xs => xs.reduce((x, y) => x + y, 0)

/** compaction-basic block of the dumped config, plus the threshold rc.2's formula gives. */
export function compactionConfig(yaml, contextWindow, requestMaxTokens = 32768) {
  const m = yaml.match(/^- id: compaction-basic\n([\s\S]*?)(?=^- |^# ==|(?![\s\S]))/m)
  const block = m ? m[1] : ''
  const num = k => { const r = block.match(new RegExp(`^\\s+${k}: *([\\d_.]+)`, 'm')); return r ? Number(r[1].replace(/_/g, '')) : undefined }
  const headroomTokens = num('headroomTokens') ?? 65536
  const thresholdRatio = num('thresholdRatio') ?? 0.8
  const summaryMaxTokens = num('maxTokens') ?? headroomTokens
  // Mirrors packages/compaction/compaction-basic/src/config.ts resolve step (computed, not measured).
  const pressureBudget = contextWindow - requestMaxTokens - headroomTokens
  return {
    declared: block.trim() || '(no config: plugin defaults)',
    headroomTokens, thresholdRatio, summaryMaxTokens, contextWindow, requestMaxTokens,
    computedThresholdTokens: pressureBudget <= 0 ? null : Math.floor(Math.min(contextWindow * thresholdRatio, pressureBudget)),
    expectedAt80Pct: Math.floor(contextWindow * 0.8),
  }
}

/** Label each wire request normal | compaction | post-tool-change | aux. */
export function classify(requests, events) {
  const windows = []
  const open = new Map()
  for (const e of events) {
    if (e.type === 'compaction/start') open.set(e.data.compactionId, e.time)
    if (e.type === 'compaction/end') windows.push([open.get(e.data.compactionId) ?? e.time, e.time])
  }
  let lastTools
  let phase = 'main'
  return requests.map(r => {
    let kind
    if (windows.some(([s, e]) => r.t0 >= s && r.t0 <= e)) kind = 'compaction'
    else if (!r.tools) kind = 'aux' // session title and other tool-less side calls
    else if ((r.phase ?? 'main') !== phase) {
      phase = r.phase
      kind = 'resumed'
      lastTools = r.toolsHash
    } else {
      kind = lastTools !== undefined && r.toolsHash !== lastTools ? 'post-tool-change' : 'normal'
      lastTools = r.toolsHash
    }
    return { ...r, kind }
  })
}

const cached = r => r.usage?.prompt_tokens_details?.cached_tokens ?? r.timings?.cache_n ?? null
const promptTokens = r => r.usage?.prompt_tokens ?? (r.timings ? r.timings.prompt_n + (r.timings.cache_n ?? 0) : null)

function requestStats(rs) {
  const withUsage = rs.filter(r => cached(r) !== null && promptTokens(r))
  const prompt = sum(withUsage.map(promptTokens))
  return {
    count: rs.length,
    errors: rs.filter(r => r.error || (r.status && r.status >= 400)).length,
    reasoningEffort: [...new Set(rs.map(r => r.reasoning_effort ?? 'unset'))],
    promptTokens: prompt,
    cachedTokens: sum(withUsage.map(cached)),
    cacheHitRatio: prompt ? +(sum(withUsage.map(cached)) / prompt).toFixed(3) : null,
    uncachedTokens: prompt - sum(withUsage.map(cached)),
    ttftMsP50: pct(rs.map(r => r.ttftMs).filter(x => x !== undefined), 0.5),
    ttftMsP90: pct(rs.map(r => r.ttftMs).filter(x => x !== undefined), 0.9),
    ttftMsMax: pct(rs.map(r => r.ttftMs).filter(x => x !== undefined), 1),
    prefillMsTotal: Math.round(sum(rs.map(r => r.timings?.prompt_ms ?? 0))),
    totalMs: sum(rs.map(r => r.totalMs ?? 0)),
    sharedPrefixRatioP50: pct(rs.filter(r => r.promptChars).map(r => r.sharedPrefixChars / r.promptChars), 0.5),
  }
}

function heapStats(samples) {
  if (!samples.length) return null
  const mb = b => +(b / 2 ** 20).toFixed(1)
  const t0 = samples[0].t
  // Slope skips the first 60 s: boot loads every plugin and would swamp the trend.
  const steady = samples.filter(s => s.t - t0 >= 60_000)
  const xs = steady.map(s => (s.t - t0) / 3.6e6)
  const ys = steady.map(s => s.heapUsed / 2 ** 20)
  const mx = sum(xs) / xs.length, my = sum(ys) / ys.length
  const den = sum(xs.map(x => (x - mx) ** 2))
  return {
    samples: samples.length,
    heapUsedFirstMB: mb(samples[0].heapUsed),
    heapUsedMaxMB: mb(Math.max(...samples.map(s => s.heapUsed))),
    heapUsedLastMB: mb(samples.at(-1).heapUsed),
    rssMaxMB: mb(Math.max(...samples.map(s => s.rss))),
    heapSlopeMBPerHour: xs.length > 2 && den ? +(sum(xs.map((x, i) => (x - mx) * (ys[i] - my))) / den).toFixed(1) : null,
    gcMsTotal: sum(samples.map(s => s.gcMs)),
    gcCount: sum(samples.map(s => s.gcCount)),
  }
}

export function analyze({ meta, configYaml, requestsFile, heapFile, events, notes }) {
  const requests = classify(jsonl(requestsFile), events)
  const kinds = ['normal', 'compaction', 'post-tool-change', 'resumed', 'aux']
  const byKind = Object.fromEntries(kinds.map(k => [k, requestStats(requests.filter(r => r.kind === k))]))

  const starts = events.filter(e => e.type === 'compaction/start')
  const ends = events.filter(e => e.type === 'compaction/end')
  const failed = ends.filter(e => e.data.error)
  const steps = events.filter(e => e.type === 'step/start').length
  // Prompt size the main loop had reached right before each compaction began (measured trigger point).
  const triggerTokens = starts.map(s => {
    const prev = requests.filter(r => r.kind !== 'compaction' && r.kind !== 'aux' && r.t0 < s.time).at(-1)
    return prev ? promptTokens(prev) : null
  })
  const errorCounts = {}
  const failureClasses = {}
  for (const e of failed) {
    const k = e.data.error.replace(/\d+/g, 'N').slice(0, 160)
    errorCounts[k] = (errorCounts[k] ?? 0) + 1
    const s = starts.find(x => x.data.compactionId === e.data.compactionId)
    const calls = requests.filter(r => r.kind === 'compaction' && s && r.t0 >= s.time && r.t0 <= e.time)
    const cls = failureClass(e.data.error, calls)
    failureClasses[cls] = (failureClasses[cls] ?? 0) + 1
  }
  const durations = ends.map(e => {
    const s = starts.find(x => x.data.compactionId === e.data.compactionId)
    return s ? e.time - s.time : null
  }).filter(x => x !== null)

  const headers = events.filter(e => e.type === 'request/header')
  const turnEnd = events.filter(e => e.type === 'turn/end').at(-1)
  const notesLines = existsSync(notes ?? '') ? readFileSync(notes, 'utf8').split('\n').filter(l => /module_\d+/.test(l)).length : null

  return {
    meta,
    config: compactionConfig(existsSync(configYaml ?? '') ? readFileSync(configYaml, 'utf8') : '', meta.contextWindow),
    progress: {
      steps,
      filesNoted: notesLines,
      filesTotal: meta.files,
      turnEnd: turnEnd?.data?.reason ?? null,
      toolChangeHeaders: headers.filter(h => h.data.reason === 'change').length,
      requestHeaderReasons: headers.map(h => h.data.reason),
    },
    compaction: {
      started: starts.length,
      ended: ends.length,
      failed: failed.length,
      stepsPerCompaction: starts.length ? +(steps / starts.length).toFixed(1) : null,
      triggerPromptTokens: triggerTokens,
      durationMs: { p50: pct(durations, 0.5), max: pct(durations, 1), total: sum(durations) },
      errors: errorCounts,
      failureClasses,
      // What the summarizer sent: #5521 hinges on tools without tool_choice, #3465 on the cap.
      requestShape: [...new Set(requests.filter(r => r.kind === 'compaction')
        .map(r => `tools=${r.tools} tool_choice=${JSON.stringify(r.tool_choice)} max_tokens=${r.max_tokens} effort=${r.reasoning_effort ?? 'unset'} finish=${r.finishReason ?? '?'}`))],
    },
    // pi-ai's stream idle watchdog defaults to 300 s (#6553): a silent prefill past it kills the request.
    idleTimeout: {
      ttfbMsMax: pct(requests.map(r => r.ttfbMs).filter(x => x !== undefined), 1),
      ttftMsMax: pct(requests.map(r => r.ttftMs).filter(x => x !== undefined), 1),
      over240s: requests.filter(r => (r.ttftMs ?? r.totalMs ?? 0) > 240_000).length,
      over300s: requests.filter(r => (r.ttftMs ?? r.totalMs ?? 0) > 300_000).length,
      transportErrors: requests.filter(r => r.error).map(r => r.error),
    },
    requests: byKind,
    heap: heapStats(jsonl(heapFile)),
  }
}

/** Map a failed compaction to the upstream report it matches. */
export function failureClass(error, calls) {
  if (calls.some(r => r.finishReason === 'length')) return '#3465 summary hit its max_tokens cap'
  if (/no text summary/i.test(error)) return calls.some(r => r.finishReason === 'tool_calls')
    ? '#5521 answered with a tool call, no summary' : '#5521-like: no text summary'
  if (/not smaller/i.test(error)) return '#7212/#8785 summary not smaller than shadowed content'
  return 'other'
}

const n = x => x === null || x === undefined ? '–' : typeof x === 'number' ? x.toLocaleString('en-US') : String(x)

export function renderMarkdown(r) {
  const m = r.meta, c = r.config, k = r.compaction, p = r.progress
  const row = (name, s) => `| ${name} | ${s.count} | ${s.reasoningEffort.join(', ')} | ${n(s.promptTokens)} | ${n(s.cachedTokens)} | ${n(s.cacheHitRatio)} | ${n(s.ttftMsP50)} | ${n(s.ttftMsMax)} | ${n(s.prefillMsTotal)} |`
  return `# Qwen e2e: ${m.label} / ${m.scenario}

harness ${m.harness} @ ${m.commit} · exit ${m.exitCode} · wall ${(m.wallMs / 60000).toFixed(1)} min · session ${m.sessionId ?? '–'}

## 1. Effective config
declared window ${n(c.contextWindow)} · request maxTokens ${n(c.requestMaxTokens)} · headroom ${n(c.headroomTokens)} · ratio ${c.thresholdRatio} · summary maxTokens ${n(c.summaryMaxTokens)}
computed trigger (rc.2 formula and defaults; ignore on branches that change them) ${n(c.computedThresholdTokens)} tokens (80% would be ${n(c.expectedAt80Pct)})

## 2. Compaction vs steps
steps ${p.steps} · files noted ${n(p.filesNoted)}/${p.filesTotal} · compactions ${k.started} (failed ${k.failed}) · steps per compaction ${n(k.stepsPerCompaction)}
measured trigger prompt tokens: ${k.triggerPromptTokens.map(n).join(', ') || '–'}
compaction time p50 ${n(k.durationMs.p50)} ms · max ${n(k.durationMs.max)} ms · total ${n(k.durationMs.total)} ms
${Object.entries(k.failureClasses).map(([e, c]) => `- ${c}× ${e}`).join('\n')}
${Object.entries(k.errors).map(([e, c]) => `  - raw: ${c}× ${e}`).join('\n')}
compaction request shape: ${k.requestShape.join(' | ') || '–'}

## 3–4. Requests: effort, cache, time to first token
| kind | n | reasoning_effort | prompt tok | cached tok | hit ratio | TTFT p50 ms | TTFT max ms | prefill ms |
|---|---|---|---|---|---|---|---|---|
${Object.entries(r.requests).filter(([, s]) => s.count).map(([name, s]) => row(name, s)).join('\n')}

tool-change headers: ${p.toolChangeHeaders} · header reasons: ${p.requestHeaderReasons.join(', ') || '–'}

idle watchdog (#6553, 300 s): max TTFB ${n(r.idleTimeout.ttfbMsMax)} ms · max TTFT ${n(r.idleTimeout.ttftMsMax)} ms · over 240 s ${r.idleTimeout.over240s} · over 300 s ${r.idleTimeout.over300s} · transport errors ${r.idleTimeout.transportErrors.length}
resume exit ${m.resumeCode ?? '–'}

## 5. dsh Node heap
${r.heap ? `first ${r.heap.heapUsedFirstMB} MB · max ${r.heap.heapUsedMaxMB} MB · last ${r.heap.heapUsedLastMB} MB · slope ${n(r.heap.heapSlopeMBPerHour)} MB/h · rss max ${r.heap.rssMaxMB} MB · GC ${n(r.heap.gcMsTotal)} ms over ${n(r.heap.gcCount)} pauses` : 'no samples'}
`
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const dir = process.argv[2]
  const old = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
  const report = analyze({
    meta: old.meta, configYaml: join(dir, 'config.yml'), requestsFile: join(dir, 'requests.jsonl'),
    heapFile: join(dir, 'heap.jsonl'), events: old.meta.sessionLog ? readSessionLog(old.meta.sessionLog) : [],
    notes: join(dir, 'workspace', 'NOTES.md'),
  })
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2))
  writeFileSync(join(dir, 'report.md'), renderMarkdown(report))
  console.log(renderMarkdown(report))
}
