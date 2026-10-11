// Tiny dependency-free stdio MCP server for the tool-change probe (#935).
// It starts with one tool, `add_tool`. Calling it registers `extra_tool` and
// sends notifications/tools/list_changed, so dsh's next model request carries
// a different tool catalog inside the same process (request/header reason 'change').
import { createInterface } from 'node:readline'

const tools = [{
  name: 'add_tool',
  description: 'Registers one more tool named extra_tool. Call it exactly when the task says so.',
  inputSchema: { type: 'object', properties: {} },
}]
const send = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))

createInterface({ input: process.stdin }).on('line', async line => {
  let m
  try { m = JSON.parse(line) } catch { return } // not JSON-RPC: ignore, the client owns framing
  if (m.id === undefined) return // a notification from the client needs no answer
  switch (m.method) {
    case 'initialize':
      return send({ id: m.id, result: {
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'dyn', version: '1.0.0' },
      } })
    case 'tools/list':
      return send({ id: m.id, result: { tools } })
    case 'tools/call': {
      const name = m.params?.name
      if (name === 'add_tool' && !tools.some(t => t.name === 'extra_tool')) {
        tools.push({
          name: 'extra_tool',
          description: 'Returns the word ok.',
          inputSchema: { type: 'object', properties: {} },
        })
        send({ method: 'notifications/tools/list_changed' })
        await sleep(Number(process.env.DYN_MCP_SETTLE_MS ?? 1000)) // let the client re-list before we return
      }
      return send({ id: m.id, result: { content: [{ type: 'text', text: name === 'add_tool' ? 'extra_tool registered' : 'ok' }] } })
    }
    case 'ping':
      return send({ id: m.id, result: {} })
    default:
      return send({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } })
  }
})
