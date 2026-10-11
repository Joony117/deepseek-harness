// Scripted stand-in for the Qwen server, for a no-GPU dry run of the whole
// pipeline (dsh -> proxy -> here). It plays the task: read each src file with
// the read tool, after file N call add_tool then extra_tool, then say DONE.
// Usage numbers are fake; only the plumbing is under test.
import http from 'node:http'
import { readdirSync } from 'node:fs'

const FILES = Number(process.env.MOCK_FILES ?? 3)
const CHANGE_AFTER = Number(process.env.MOCK_CHANGE_AFTER ?? 1)

function plan(body) {
  const tools = (body.tools ?? []).map(t => t.function.name)
  const done = (body.messages ?? []).filter(m => m.role === 'tool').length
  const last = JSON.stringify(body.messages?.at(-1)?.content ?? '')
  // MOCK_SUMMARY=tool replays #5521 (Qwen answers the compaction prompt with a tool call).
  if (!tools.length || (/summar|checkpoint/i.test(last) && process.env.MOCK_SUMMARY !== 'tool')) return { text: 'Summary of the earlier conversation.' }
  if (!/read each|ONE file per step|NOTES/.test(JSON.stringify(body.messages))) return { text: 'DONE' }
  const read = tools.find(n => n === 'read' || n === 'read_file') ?? tools.find(n => /read/.test(n))
  const props = Object.keys(body.tools.find(t => t.function.name === read)?.function.parameters?.properties ?? {})
  const key = props.find(k => /path/.test(k)) ?? 'path'
  // Script: read f1..fN, inserting the two MCP calls after file CHANGE_AFTER.
  const steps = []
  for (let i = 0; i < FILES; i++) {
    const file = readdirSync(`${process.env.MOCK_WS}/src`).sort()[i]
    steps.push({ name: read, args: { [key]: `src/${file}` } })
    if (i + 1 === CHANGE_AFTER) steps.push({ name: 'mcp__dyn__add_tool', args: {} }, { name: 'mcp__dyn__extra_tool', args: {} })
  }
  const s = steps[done]
  return s ? { tool: s } : { text: 'DONE' }
}

let n = 0
http.createServer((req, res) => {
  if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }))
  if (req.url.endsWith('/health')) return res.end('{"status":"ok"}')
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const p = plan(body)
    const id = `mock-${n++}`
    const prompt = JSON.stringify(body.messages).length >> 2
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = o => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, ...o })}\n\n`)
    setTimeout(() => {
      if (p.tool) {
        send({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: p.tool.name, arguments: JSON.stringify(p.tool.args) } }] } }] })
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        send({ choices: [{ index: 0, delta: { role: 'assistant', content: p.text } }] })
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      send({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: 5, total_tokens: prompt + 5, prompt_tokens_details: { cached_tokens: Math.floor(prompt * 0.9) } },
        timings: { prompt_n: prompt - Math.floor(prompt * 0.9), prompt_ms: 10, cache_n: Math.floor(prompt * 0.9) } })
      res.end('data: [DONE]\n\n')
    }, 20)
  })
}).listen(Number(process.argv[2] ?? 8099), '127.0.0.1')
