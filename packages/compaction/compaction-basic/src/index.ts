/**
 * Basic replay-aware compaction backend.
 *
 * @module @deepseek-ai/dsh-compaction-basic
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, CompactionId, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './config.ts'
import {
  assertNoActiveCompaction,
  compactSurfaceRegion,
  selectCompactableRange,
} from './region.ts'
import { COMPACTION_INSTRUCTION, summarizeWithLlm } from './summarizer.ts'
import type { SummarizationInput, SummaryResult } from './summarizer.ts'
import type {
  BasicCompactionConfig,
  ModelCompactPolicyConfig,
  ResolvedConfig,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/**
 * Output tokens the routed request reserves, which the provider charges to the
 * same window as the prompt. The effective envelope's own cap wins; otherwise
 * the adapter's per-request default, which the adapter materializes when that
 * envelope omits one. No declared cap means no reservation.
 */
function reservedCompletionTokens(agent: Agent, defaultMaxTokens: number | undefined): number {
  const configured = agent.session.requestHeader()?.config.maxTokens
  return configured ?? defaultMaxTokens ?? 0
}

/** Resolve the conversation target used to select an optional policy override. */
function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}

/** What a failed automatic attempt already left in the log, and whose turn a record would name. */
interface AutomaticFailureEntry {
  /** The open turn a synthetic bracket must name, or `null` between turns. */
  readonly turn: number | null
  /** True when nothing further should be appended for this failure. */
  readonly traced: boolean
}

/**
 * Read back, from the durable log alone, whether this compaction attempt
 * already left a trace and which turn encloses the attempt.
 *
 * A failure inside the region transaction closes its own bracket carrying the
 * error, and a bracket whose close itself failed is left as a detectable
 * unmatched `compaction/start` (`compactSurfaceRegion`'s own close-failure
 * path). Appending a synthetic marker pair over the first would report one
 * failure twice; over the second it would look like a matched bracket and
 * silently repair a lock the region left broken. A bracket this attempt closed
 * *successfully* is not a trace of the failure — a retry budget spent while
 * still above threshold ends exactly that way — so it does not suppress the
 * record. A later `session/end-seed` clears an inherited unmatched start, the
 * same staleness rule `assertNoActiveCompaction` applies.
 *
 * The enclosing turn is read from the log rather than taken from the hook
 * payload because the log is what the bracket is validated against:
 * `compactSurfaceRegion` derives its own owner the same way.
 * @param session - session whose durable log is inspected.
 * @param from - log length captured before the attempt began.
 * @returns the enclosing turn and whether a durable trace already exists.
 */
function inspectAutomaticFailure(session: Session, from: number): AutomaticFailureEntry {
  let turn: number | null = null
  let turnKnown = false
  let traced = false
  let compactionKnown = false
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    // Every seq below `session.seq` is a logged event.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const event = session.eventAt(SessionSeq(seq))!
    if (!compactionKnown) {
      compactionKnown = true
      if (event.type === 'compaction/start') traced = true
      else if (event.type === 'compaction/end') traced = seq >= from && event.data.error !== undefined
      else if (event.type !== 'session/end-seed') compactionKnown = false
    }
    if (!turnKnown) {
      if (event.type === 'turn/start') {
        turn = event.data.turn
        turnKnown = true
      } else if (event.type === 'turn/end') turnKnown = true
    }
    if (compactionKnown && turnKnown) break
  }
  return { turn, traced }
}

/** Smallest summary cap worth replaying the whole surface for on an append-only route. */
const MIN_SUMMARY_ROOM_TOKENS = 8192

const thresholdRatioSchema = z.number()
const headroomTokensSchema = z.number().step(1).min(0)
const retainRatioSchema = z.number()
const retainTokensSchema = z.number().step(1).min(0)
const summarizationProviderSchema = z.string()
const summarizationModelSchema = z.string()
const maxTokensSchema = z.number().step(1).min(1)
const compactionRetriesSchema = z.number().step(1).min(0)
const maxOverflowRetriesSchema = z.number().step(1).min(0)
const appendOnlySchema = z.boolean()

const modelPolicy: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  thresholdRatio: thresholdRatioSchema,
  headroomTokens: headroomTokensSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
  appendOnly: appendOnlySchema,
})

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config: z<BasicCompactionConfig> = z.object({
    thresholdRatio: thresholdRatioSchema,
    headroomTokens: headroomTokensSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    appendOnly: appendOnlySchema,
    modelPolicies: z.array(modelPolicy),
    auto: z.boolean(),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  private readonly warnedPressureConfigTargets = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()
  private readonly overflowAgents = new WeakMap<Session, Agent>()
  /**
   * Pressure at which an automatic attempt last failed to bring a session
   * below threshold (#7212 rejected summary, #5669 still above threshold).
   * Process-local; a restart retries once early.
   */
  private readonly pressureBackoff = new WeakMap<Session, { targetKey: string; totalTokens: number }>()

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) this._registerAutomaticCompaction()
  }

  /**
   * Register automatic between-step pressure and model-request overflow
   * recovery. `compactIfNeeded` stays dynamically dispatched so subclass
   * overrides are honored at event time.
   */
  private _registerAutomaticCompaction(): void {
    const { ctx } = this
    const logResult = (result: CompactionResult, trigger: string): void => {
      ctx.logger.info(
        `compaction (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
        + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
        + `~${result.shadowedTokenCount} tokens)`,
      )
    }

    ctx.on('agent/pre-step', async (
      { agent, signal },
      next,
    ): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        const from = agent.session.seq
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) logResult(result, 'step pressure')
        } catch (error: unknown) {
          if (error instanceof TargetPressureConfigError) {
            if (this.warnedPressureConfigTargets.has(error.targetKey)) return next()
            this.warnedPressureConfigTargets.add(error.targetKey)
          }
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
          // A pressure config error is warned once and never recorded: no compaction was attempted.
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
          if (!signal.aborted && !(error instanceof TargetPressureConfigError)) {
            this.recordAutomaticFailure(agent.session, 'step pressure', error, from)
          }
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // A successful response starts a fresh overflow-recovery sequence even
    // when tool calls continue the same turn into another request.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const agent = this.overflowAgents.get(session)
      if (agent !== undefined) this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      this.overflowAgents.set(agent.session, agent)
      const target = routedTarget(agent.session)
      if (target === undefined) return next()
      const policy = resolveTargetPolicy(this.config, target)
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= policy.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      const from = agent.session.seq
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (recoveryError: unknown) {
        const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        // A model-free prune can land before later summary work fails. That
        // durable reduction is sufficient retry proof; do not discard it just
        // because the optional second phase threw. Cancellation still wins.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          ctx.logger.warn(
            `context-overflow compaction failed after durable surface progress: ${message}; `
            + 'retrying from the replacement surface',
          )
          this.recordAutomaticFailure(agent.session, 'context overflow recovery', recoveryError, from)
          this.overflowRetries.set(agent, retries + 1)
          return { kind: 'retry' }
        }
        ctx.logger.warn(
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
          `context-overflow compaction failed: ${message}; ${signal.aborted
            ? 'cancellation prevents retry'
            : 'preserving the original request error'}`,
        )
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while recovery is awaited.
        if (!signal.aborted) {
          this.recordAutomaticFailure(agent.session, 'context overflow recovery', recoveryError, from)
        }
        return next()
      }
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while compaction is awaited.
      if (signal.aborted
        || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) logResult(result, 'context overflow recovery')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const target = conversationTarget(agent)
    const config = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    const room = target !== undefined && input.surface !== undefined
      ? await this.appendOnlyRoom(config, agent, target, signal)
      : undefined
    if (room === undefined || input.surface === undefined) {
      return summarizeWithLlm(this.ctx, config, input, agent, signal)
    }
    return summarizeWithLlm(this.ctx, { ...config, maxTokens: room }, { ...input, messages: input.surface }, agent, signal)
  }

  /**
   * Output room left when the summary replays the whole surface, so an
   * append-only server extends its cache instead of re-reading from an early
   * checkpoint. The shadowed-region replay instead cuts the prompt short and
   * puts the directive where the next message was, so such a server falls back
   * to an early checkpoint (10,777 of 47,909 tokens reused in one ninfer run).
   * @returns the summary token cap for the whole-surface form, or `undefined`
   * to keep the shadowed-region form (another summary model, or too little room).
   */
  private async appendOnlyRoom(
    config: { summarizationProvider: string; maxTokens: number; appendOnly: boolean },
    agent: Agent,
    target: Pick<LlmCallConfig, 'provider' | 'model'>,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    if (config.summarizationProvider.length > 0) return undefined
    let info: LlmResolvedModelInfo
    try {
      info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    } catch {
      // Advisory, like the summarizer's own capability lookup: fall back to the region form.
      return undefined
    }
    if (!config.appendOnly && info.promptCache !== 'append-only') return undefined
    const contextWindow = info.context?.contextWindow
    if (contextWindow === undefined) return undefined
    const meter = this.ctx.tokenMeter
    const prompt = meter.measure(agent.session).totalTokens
      + meter.estimateMessage(createUserMessage({
        content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
        source: { kind: 'user' },
      }))
    const room = Math.min(config.maxTokens, contextWindow - prompt)
    // ponytail: fixed floor; a checkpoint is a few thousand tokens. Make it a policy field if one runs out.
    return room >= Math.min(config.maxTokens, MIN_SUMMARY_ROOM_TOKENS) ? room : undefined
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed context
   * overflow. Both triggers price the latest durable routed request envelope;
   * overflow bypasses the normal threshold and retained-tail policy so it can
   * force one useful balanced reduction.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const policy = resolveTargetPolicy(this.config, target)
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)
    switch (trigger) {
      case 'context-overflow':
        break
      case 'pressure':
        break
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        assertNever(trigger, 'compaction trigger')
    }

    // Pruning is optional so compaction-basic remains independently composable.
    // Overflow always qualifies; pressure first resolves the routed model's
    // capacity and checks its target-specific threshold.
    const prune = this.ctx.get('toolResultPruner')

    if (trigger === 'context-overflow') {
      if (prune !== undefined) {
        prune.pruneSession(agent.session)
        measurement = meter.measure(agent.session)
      }
      const range = selectCompactableRange(agent.session, measurement, 0)
      if (range === null) return null
      return this.compactRegion(range.start, range.end, agent, signal)
    }

    const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (info.context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that adapter model',
      )
    }
    const spec = resolveCompactSpec(
      info.promptCache === 'append-only' ? { ...policy, appendOnly: true } : policy,
      info.context.contextWindow,
      reservedCompletionTokens(agent, info.defaultMaxTokens),
    )
    if (measurement.totalTokens < spec.thresholdTokens) {
      this.pressureBackoff.delete(agent.session)
      return null
    }

    // Once pressure qualifies, land the model-free pass before choosing a
    // summary range, then remeasure through the singleton replay fold. An
    // append-only route skips it: trimming an old result rewrites the middle of
    // the prompt, so the server re-reads everything after it with no summary to
    // show for it. There the trim waits until a summary has already broken the
    // prefix (below).
    if (prune !== undefined && !spec.appendOnly) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < spec.thresholdTokens) {
      this.pressureBackoff.delete(agent.session)
      return null
    }

    // After a non-converging attempt, wait for real growth instead of paying
    // for the same summary again on every tool step.
    // ponytail: fixed 5% of the window (max 32K); make it a policy field if routes need tuning.
    const backoff = this.pressureBackoff.get(agent.session)
    const growthTokens = Math.max(1, Math.min(Math.floor(spec.contextWindow * 0.05), 32_768))
    if (backoff?.targetKey === targetKey
      && measurement.totalTokens < backoff.totalTokens + growthTokens) return null

    let result: CompactionResult | null = null
    try {
      for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
        const range = selectCompactableRange(agent.session, measurement, spec.retainTokens)
        if (range === null) {
          /* v8 ignore else -- concrete replacement preserves a compactable checkpoint; subclass hooks cannot mutate it. */
          if (result === null) return null
          /* v8 ignore next -- paired with the defensive post-success branch above. */
          break
        }
        result = await this.compactRegion(range.start, range.end, agent, signal)
        if (spec.appendOnly && prune !== undefined) prune.pruneSession(agent.session)
        measurement = meter.measure(agent.session)
        if (measurement.totalTokens < spec.thresholdTokens) {
          this.pressureBackoff.delete(agent.session)
          return result
        }
      }

      throw new Error(
        `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts `
        + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
      )
    } catch (error: unknown) {
      // A failed attempt leaves the surface unchanged, so `measurement` is current.
      if (!signal.aborted) {
        this.pressureBackoff.set(agent.session, { targetKey, totalTokens: measurement.totalTokens })
      }
      throw error
    }
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      { owner: 'current-turn', stability: 'whole-surface' },
      signal,
    )
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const range = selectCompactableRange(
            agent.session,
            this.ctx.tokenMeter.measure(agent.session),
            0,
          )
          if (range === null) return null
          return await compactSurfaceRegion(
            this.regionDependencies(),
            agent.session,
            range.start,
            range.end,
            agent,
            {
              owner: null,
              stability: 'selected-span',
              ...sourceCommandId === undefined ? {} : { sourceCommandId },
              flush: async () => {
                await this.ctx.sessions.flush(agent.session)
              },
            },
            operationSignal,
          )
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError(
              'cancelled',
              'manual compaction was cancelled',
              { cause: error },
            )
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      throw new ManualCompactionError(
        'busy',
        'manual compaction requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /**
   * Surface one automatic-path compaction failure on the session's own
   * compaction lifecycle, so it reaches a reader of the session instead of
   * living only in this process's log.
   *
   * The automatic triggers swallow every failure to keep the turn alive, which
   * is right — but a failure that never reached the region transaction (an
   * unconfigured routed capacity, a retry budget spent still above threshold,
   * a selection or metering fault) leaves no durable trace at all, and the turn
   * continues silently degraded. A closed `compaction/start`/`compaction/end`
   * pair carrying the error is the record the region transaction already writes
   * for its own failures, so `ui-trajectory` renders it as a failed compaction
   * request without any presentation change. (`ui-chat` does not: its automatic
   * conversation node returns null with no landed checkpoint, so a failed
   * automatic compaction stays invisible in chat either way.)
   *
   * NOT atomic, and the two appends cannot be made atomic here. The close is
   * built before the open so the one failure mode this code owns — an
   * unserializable payload — is raised before anything is appended; that is the
   * limit of what payload construction buys. If the close append itself is
   * rejected, the open is left as a detectable unmatched `compaction/start`,
   * exactly the residue `compactSurfaceRegion`'s own close-failure path leaves:
   * `assertNoActiveCompaction` refuses the next compaction against it, and a
   * later `session/end-seed` clears it. Under the rc.1 compaction invariant
   * that residue cannot arise from the invariant itself — the pair is appended
   * synchronously with one shared lifecycle, so no clause the close evaluates
   * can have changed since the open was accepted — but any other mounted
   * observer that rejects the close and not the open would produce it.
   *
   * Advisory by construction: it records nothing for an attempt already traced,
   * it never throws, and it never influences what the calling hook decides next.
   * @param session - session whose durable log receives the marker pair.
   * @param trigger - which automatic trigger failed, for the recorded message.
   * @param error - the swallowed failure.
   * @param from - log length captured before the attempt began.
   */
  private recordAutomaticFailure(
    session: Session,
    trigger: string,
    error: unknown,
    from: number,
  ): void {
    try {
      const entry = inspectAutomaticFailure(session, from)
      if (entry.traced) return
      const message = error instanceof Error ? error.message : String(error)
      const lifecycle = { compactionId: CompactionId(randomUUID()), turn: entry.turn }
      const close = { ...lifecycle, error: `automatic compaction (${trigger}) failed: ${message}` }
      session.append('compaction/start', lifecycle)
      session.append('compaction/end', close)
    } catch (recordError: unknown) {
      // Reporting a failure must never become one: the turn continues either way.
      this.ctx.logger.warn(
        `compaction-basic: could not record the ${trigger} compaction failure: `
        + (recordError instanceof Error ? recordError.message : String(recordError)),
      )
    }
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(): Parameters<typeof compactSurfaceRegion>[0] {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
      recover: (error, agent, sourceEventSeqs, signal) => this.ctx.waterfall('compaction/summary-error', {
        session: agent.session,
        sourceEventSeqs,
        error,
        ...signal === undefined ? {} : { signal },
      }, () => false),
    }
  }
}

export default BasicCompactionEngine
