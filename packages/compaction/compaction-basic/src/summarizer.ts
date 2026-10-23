/**
 * Default one-shot summarization and durable checkpoint framing.
 *
 * @module @deepseek-ai/dsh-compaction-basic/summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import { contentHasImage, BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, RequestMessage, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The adapter-owned reasoning level meaning "produce no thinking". A thinking
 * model spends the summarization output cap on reasoning before it writes a
 * single checkpoint line, so the call finishes `max-tokens` with nothing
 * usable; selecting this level spends the whole cap on the checkpoint instead.
 */
const NO_THINKING_EFFORT = 'off'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
export const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/**
 * Sent once, after the instruction, when the model answered the instruction
 * with only tool calls. The rejected output is not replayed, so the request is
 * the first one's cached prefix plus this message.
 */
const NO_TOOLS_NUDGE =
  'Tool calls are disabled for this request; any tool call is discarded. Do not call a tool. Output only the checkpoint text in the structure above.'

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input.
 */
export interface SummarizationInput {
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[]
  /** The derived system head, when present, followed by the shadowed region in surface order. */
  readonly messages: readonly Message[]
  /** The whole derived surface, as the next routed request would send it. */
  readonly surface?: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
} & (
  | {
    /** Complete provider output before the text-only summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies the call through this context's `ctx.llm.stream()` that produced `rawOutput`. */
    llmStreamCall: true
    /** Output of an earlier call on the same seam that held only tool calls, followed by one re-ask. */
    rejectedOutput?: ContentBlock[]
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked result does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/**
 * Resolve the no-thinking reasoning level for one exact route, when that route
 * advertises one. Used only off the conversation's own route, where there is
 * no warm prefix for a matching effort to reuse.
 *
 * Call resolution rejects an effort the resolved model does not advertise, and
 * compaction runs against every routable model — non-reasoning models and
 * reasoning models with no `off` level included — so an unconditional request
 * would trade a truncated checkpoint for a guaranteed failure. Capability
 * lookup is advisory for the same reason: a context whose LLM seam is absent,
 * doubled, or offline must summarize exactly as it did before rather than gain
 * a new way to fail.
 * @param ctx - context providing the LLM service.
 * @param target - the exact provider/model this summarization will route to.
 * @param signal - optional cancellation forwarded to capability lookup.
 * @returns the advertised no-thinking effort, or `undefined` to leave the request untouched.
 */
async function noThinkingEffort(
  ctx: Context,
  target: { provider: string; model: string },
  signal?: AbortSignal,
): Promise<GenerateOptions['reasoningEffort']> {
  try {
    const info = await ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    return info.reasoning?.efforts.find(effort => effort.id === NO_THINKING_EFFORT)?.id
  } catch {
    return undefined
  }
}

/**
 * Run the default cache-reusing `ctx.llm.stream()` summarization call: replay
 * the conversation prefix, then append the compaction instruction as the final
 * user message so the provider's warm prefix cache is reused.
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns safe text-only summary blocks and the exact call envelope and output.
 */
export async function summarizeWithLlm(
  ctx: Context,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const messages: RequestMessage[] = [
    ...input.messages,
    deepFreeze({
      role: 'user',
      content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
    }),
  ]
  // On the conversation's own route, keep its effort: a chat template may
  // render the effort into the prompt, so a different one re-prefills the
  // whole replayed prefix instead of reusing the warm cache.
  const reasoningEffort = latest !== undefined
    && latest.provider === target.provider
    && latest.model === target.model
    ? latest.reasoningEffort
    : await noThinkingEffort(ctx, target, signal)
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    toolHistory: agent.session.toolHistory(),
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  }
  let call = await streamOnce(ctx, options)
  let summary = summaryText(call.blocks)
  let rejectedOutput: ContentBlock[] | undefined
  // A tool-oriented model can answer the instruction with a tool call even
  // though the tools are only replayed for the cache. Ask once more instead of
  // failing the whole compaction.
  if (!hasText(summary) && call.blocks.some(block => block.type === 'tool-call')) {
    rejectedOutput = call.blocks
    call = await streamOnce(ctx, {
      ...options,
      messages: [...messages, deepFreeze({ role: 'user', content: [{ type: 'text', text: NO_TOOLS_NUDGE }] })],
    })
    summary = summaryText(call.blocks)
  }
  if (!hasText(summary)) {
    throw new Error('summarization produced no text summary content')
  }
  const { blocks: rawOutput, usage } = call
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    ...rejectedOutput === undefined ? {} : { rejectedOutput },
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(usage === undefined ? {} : { usage }),
  }
}

/** Run one summarization stream to a successful finish, or throw its fail-closed error. */
async function streamOnce(
  ctx: Context,
  options: GenerateOptions,
): Promise<{ blocks: ContentBlock[]; usage?: TokenUsage }> {
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error
  return { blocks: assembler.blocks(), ...assembler.usage === undefined ? {} : { usage: assembler.usage } }
}

/** Whether summary text has any non-whitespace content. */
function hasText(summary: readonly Extract<ContentBlock, { type: 'text' }>[]): boolean {
  return summary.some(block => block.text.trim().length > 0)
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 * @param summary - safe text-only model output.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}
