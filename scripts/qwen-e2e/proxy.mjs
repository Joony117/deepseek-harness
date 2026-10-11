// Recording pass-through between dsh and the local OpenAI-compatible server.
// One JSONL record per /chat/completions call: what dsh sent (effort, tools,
// prefix fingerprint) and what the server reported (TTFT, cache hits, timings).
// The wire is the only place both sides are visible, so this is where we measure.
import http from 'node:http'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** Length of the shared leading run of two strings. */
export function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

/** Pull usage/timings/first-token time out of one SSE `data:` payload. */
export function readChunk(json, rec, now) {
  if (json.usage) rec.usage = json.usage
  if (json.timings) rec.timings = json.timings
  const fr = json.choices?.[0]?.finish_reason
  if (fr) rec.finishReason = fr
  const d = json.choices?.[0]?.delta ?? json.choices?.[0]?.message
  if (rec.ttftMs === undefined && d && (d.content || d.reasoning_content || d.reasoning || d.tool_calls?.length)) {
    rec.ttftMs = now - rec.t0
  }
}

/**
 * Start the proxy.
 * @param {{ port: number, upstream: string, log: string, bodies?: string, inject?: object }} opts
 *   bodies: dir for full request bodies; inject: fields merged into every chat body (server-flag experiments)
 * @returns {Promise<http.Server>}
 */
export function startProxy({ port, upstream, log, bodies, inject }) {
  if (bodies) mkdirSync(bodies, { recursive: true })
  const up = new URL(upstream)
  let previous = '' // serialized tools+messages of the previous completion call
  let seq = 0

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const isChat = req.method === 'POST' && req.url.endsWith('/chat/completions')
      let body = Buffer.concat(chunks)
      if (isChat && inject) body = Buffer.from(JSON.stringify({ ...JSON.parse(body.toString('utf8')), ...inject }))
      const rec = { seq: seq++, t0: Date.now(), url: req.url, phase: server.phase }
      if (isChat) {
        if (bodies) writeFileSync(join(bodies, `${rec.seq}.json`), body)
        try {
          const j = JSON.parse(body.toString('utf8'))
          // Prefix as the server's chat template sees it: tools first, then messages.
          const prompt = JSON.stringify({ tools: j.tools ?? [], messages: j.messages ?? [] })
          Object.assign(rec, {
            model: j.model,
            stream: j.stream === true,
            reasoning_effort: j.reasoning_effort ?? null,
            chat_template_kwargs: j.chat_template_kwargs ?? null,
            max_tokens: j.max_tokens ?? j.max_completion_tokens ?? null,
            tool_choice: j.tool_choice ?? null,
            messages: j.messages?.length ?? 0,
            tools: j.tools?.length ?? 0,
            toolNames: (j.tools ?? []).map(t => t.function?.name ?? t.name),
            toolsHash: sha(JSON.stringify(j.tools ?? [])),
            systemHash: sha(JSON.stringify(j.messages?.[0] ?? null)),
            promptChars: prompt.length,
            sharedPrefixChars: commonPrefix(previous, prompt),
            head: prompt.slice(0, 2048),
          })
          previous = prompt
        } catch (error) {
          rec.parseError = String(error) // still forward: the server owns validation
        }
      }

      const fwd = http.request({
        host: up.hostname, port: up.port, method: req.method,
        path: up.pathname.replace(/\/$/, '') + req.url.replace(/^\/v1/, ''),
        headers: { ...req.headers, host: up.host, 'content-length': body.length },
      }, upRes => {
        rec.status = upRes.statusCode
        rec.ttfbMs = Date.now() - rec.t0
        res.writeHead(upRes.statusCode, upRes.headers)
        let buf = ''
        const raw = []
        upRes.on('data', c => {
          res.write(c)
          if (!isChat) return
          if (!rec.stream) { raw.push(c); return }
          buf += c.toString('utf8')
          let nl
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') continue
            try { readChunk(JSON.parse(data), rec, Date.now()) } catch (error) { rec.chunkError = String(error) }
          }
        })
        upRes.on('end', () => {
          res.end()
          if (!isChat) return
          if (!rec.stream) {
            try { readChunk(JSON.parse(Buffer.concat(raw).toString('utf8')), rec, Date.now()) } catch (error) { rec.chunkError = String(error) }
          }
          rec.totalMs = Date.now() - rec.t0
          appendFileSync(log, JSON.stringify(rec) + '\n')
        })
      })
      fwd.on('error', error => {
        rec.error = String(error)
        if (isChat) appendFileSync(log, JSON.stringify(rec) + '\n')
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      // dsh aborting (timeout, cancel) must stop the upstream generation too.
      res.on('close', () => { if (!res.writableEnded) fwd.destroy() })
      fwd.end(body)
    })
  })
  server.phase = 'main' // the runner flips this to 'resume' for the --session-id turn
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const [port = '8089', upstream = 'http://127.0.0.1:8080/v1', log = 'requests.jsonl'] = process.argv.slice(2)
  await startProxy({ port: Number(port), upstream, log })
  console.log(`proxy :${port} -> ${upstream}, log ${log}`)
}
