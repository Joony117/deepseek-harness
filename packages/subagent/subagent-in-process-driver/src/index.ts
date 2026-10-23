/**
 * Shared driver for in-process ONE-SHOT subagent providers. The agent factory's
 * creation transaction owns unpublished setup and rollback; after publication
 * the returned AgentHandle is the one quiescent lifecycle owner held by the
 * provider's caller.
 *
 * Continuable children never come through here: the continuation manager
 * composes and drives them directly, so this driver owns exactly one turn with
 * one result.
 *
 * @module @deepseek-ai/dsh-subagent-in-process-driver
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, SessionLogOffset as SessionLogOffsetType, TurnEndReason } from '@deepseek-ai/dsh-session'
import { createUserMessage, type ContentBlock, type LlmFailure } from '@deepseek-ai/dsh-llm'
import {
  appendDelegatedPolicyOverrides,
  applyChildComposition,
  assertSubagentMaxDepth,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  finalAssistantOutput,
  resolveChildAgentOptions,
  resolveChildDepth,
} from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentDescriptorData,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import {
  attachStructuredRuntime,
  type StructuredAttachment,
} from './structured.ts'

export {
  STRUCTURED_OUTPUT_TOOL,
  STRUCTURED_OUTPUT_INSTRUCTION,
} from './structured.ts'

/** Map a session turn outcome to the subagent seam's terminal vocabulary. */
function toStopReason(reason: TurnEndReason | undefined): SubagentStopReason {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    // A pre-step rejection discarded the claimed prompt: the task was
    // declined, and the caller must not read the run as done.
    case 'blocked':
      return 'refusal'
    case 'error':
    case 'interrupted':
    default:
      return 'error'
  }
}

/** Per-child execution budget; omitted fields leave that dimension unbounded. */
export interface InProcessRunLimits {
  /** Most model steps the child's turn may enter before it is stopped. */
  readonly maxSteps?: number | undefined
  /** Wall-clock milliseconds from publication before the child is cancelled. */
  readonly deadlineMs?: number | undefined
  /**
   * Milliseconds the child may go without entering a model step before it is
   * cancelled. Restarts at every step, so slow but progressing work continues.
   */
  readonly stallMs?: number | undefined
}

/** Extra inputs the spawn and fork providers supply to the shared driver. */
export interface InProcessRunOptions {
  /** Completed-turn seed for fork, or undefined for a fresh spawn. */
  readonly seed?: readonly SessionEvent[]
  /** The provider's resolved per-child budget. */
  readonly limits?: InProcessRunLimits
}

/** Diagnostic limit from the {@link SubagentResult.diagnostic} contract. */
const MAX_DIAGNOSTIC_BYTES = 4096

/** Render a logged model failure as bounded, payload-free diagnostic text. */
function failureDiagnostic({ code, status, message }: LlmFailure): string {
  const text = `${code}${status === undefined ? '' : ` (HTTP ${status})`}: ${message}`
  const bytes = Buffer.from(text, 'utf8')
  // A cut multi-byte character decodes as one 3-byte U+FFFD; the margin keeps the bound.
  return bytes.length <= MAX_DIAGNOSTIC_BYTES
    ? text
    : `${bytes.subarray(0, MAX_DIAGNOSTIC_BYTES - 6).toString('utf8')}...`
}

/** Stop the child at the pre-step after its budget of entered steps is spent. */
function attachStepLimit(childCtx: Context, maxSteps: number, onExceeded: () => void): void {
  let entered = 0
  childCtx.on('agent/pre-step', async (_event, next) => {
    const decision = await next()
    if (decision.kind === 'enter' && ++entered > maxSteps) {
      onExceeded()
      return { kind: 'reject' }
    }
    return decision
  })
}

/** Error used when cancellation wins before the child publication boundary. */
function prePublicationAbort(): Error {
  return new Error('subagent request was aborted before child publication')
}

/** Append one one-shot descriptor inside the child's initial turn before its first request. */
function attachDescriptorAppend(childCtx: Context, descriptor: SubagentDescriptorData): void {
  let appended = false
  childCtx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (!appended && decision.kind === 'enter') {
      appended = true
      agent.session.append('subagent/descriptor', descriptor)
    }
    return decision
  })
}

/**
 * Establish and drive one in-process one-shot child. Fulfillment means the agent
 * is already published in the registry and transfers its turn, cancellation,
 * and disposal work through the returned run. Rejection means the agent
 * factory's unpublished creation transaction reached quiescence without
 * publishing a child. Every start appends its resolved descriptor inside the
 * child's initial turn.
 * @param request - the trusted typed start request, including its required signal.
 * @param options - the optional fork seed.
 * @returns a published holder-owned run.
 */
export async function startInProcessRun(
  request: ResolvedSubagentStartRequest,
  options: InProcessRunOptions,
): Promise<SubagentRun> {
  assertSubagentMaxDepth(request.maxDepth)
  if (request.signal.aborted) throw prePublicationAbort()
  const parent = request.parent
  const childDepth = resolveChildDepth(parent, request.maxDepth)

  const childId = brandString<SessionId>(randomUUID())
  const seed = options.seed
  const activationBoundary = SessionLogOffset(seed?.length ?? 0)

  // Capture before the first await: a later parent switch belongs to the
  // parent's future.
  const inherited = captureDelegatedPolicyOverrides(parent)

  let structured: StructuredAttachment | undefined
  const limits = options.limits ?? {}
  const flags: RunFlags = { cancelled: false, limit: undefined, stall: undefined }
  const setup = (childCtx: Context, child: Agent): void => {
    appendDelegatedPolicyOverrides(child.session, inherited)
    applyChildComposition(childCtx, parent, {
      persona: request.persona,
      toolFilter: request.toolFilter,
    })
    if (request.outputSchema !== undefined) {
      structured = attachStructuredRuntime(childCtx, request.outputSchema)
    }
    attachDescriptorAppend(childCtx, request.descriptor)
    const maxSteps = limits.maxSteps
    if (maxSteps !== undefined) {
      attachStepLimit(childCtx, maxSteps, () => {
        flags.limit ??= `child stopped after its limit of ${maxSteps} model steps`
      })
    }
    const stallMs = limits.stallMs
    if (stallMs !== undefined) {
      const arm = (): void => {
        clearTimeout(flags.stall)
        flags.stall = setTimeout(() => {
          flags.limit ??= `child stopped: no new model step started for ${stallMs}ms`
          child.cancel({ kind: 'parent' })
        }, stallMs)
      }
      arm()
      childCtx.on('agent/pre-step', async (_event, next) => {
        arm()
        return next()
      })
    }
  }

  const handle = await parent.ctx.agents.create({
    sessionId: childId,
    parentAgent: parent,
    meta: childSessionMeta(parent, childDepth, seed !== undefined),
    ...seed !== undefined ? { seed } : {},
    ...seed === undefined ? {} : { inheritedEventCount: activationBoundary },
    agentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),
    signal: request.signal,
    setup,
  })
  return drivePublishedRun(
    handle,
    request.signal,
    request.prompt,
    childId,
    activationBoundary,
    structured,
    flags,
    limits.deadlineMs,
  )
}

/** Mutable run state shared by setup hooks and the run lifecycle. */
interface RunFlags {
  cancelled: boolean
  /** Why a configured budget stopped the child, once one has. */
  limit: string | undefined
  /** Pending no-progress timer, re-armed at every step boundary. */
  stall: ReturnType<typeof setTimeout> | undefined
}

/**
 * Wrap a published child in the single run lifecycle that owns signal handoff,
 * one turn, result settlement, and quiescent disposal.
 */
function drivePublishedRun(
  handle: AgentHandle,
  signal: AbortSignal,
  prompt: ContentBlock[],
  childId: SessionId,
  boundary: SessionLogOffsetType,
  structured: StructuredAttachment | undefined,
  flags: RunFlags,
  deadlineMs: number | undefined,
): SubagentRun {
  const child = handle.agent
  const onAbort = (): void => {
    flags.cancelled = true
    child.cancel({ kind: 'parent' })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  // Agent creation detaches its creation-only listener before returning. The
  // post-registration check closes that handoff without treating an already
  // published child as a failed start.
  if (signal.aborted) onAbort()
  const deadline = deadlineMs === undefined
    ? undefined
    : setTimeout(() => {
      flags.limit ??= `child stopped at its ${deadlineMs}ms wall-clock deadline`
      child.cancel({ kind: 'parent' })
    }, deadlineMs)

  const result: Promise<SubagentResult> = (async () => {
    try {
      if (!flags.cancelled) {
        child.followup(createUserMessage({ content: prompt, source: { kind: 'user' } }))
        await child.whenIdle()
      }
      const settled = readResult(
        child,
        boundary,
        flags.cancelled,
        structured ? { captured: structured.captured() } : undefined,
      )
      // A spent budget is a failure even when the cut-short turn reads as
      // blocked or aborted; the caller keeps any partial output.
      return flags.limit === undefined || flags.cancelled
        ? settled
        : { output: settled.output, stopReason: 'error', diagnostic: flags.limit }
    } finally {
      clearTimeout(deadline)
      clearTimeout(flags.stall)
      signal.removeEventListener('abort', onAbort)
    }
  })()

  return {
    id: childId,
    localAgent: child,
    result,
    async dispose(): Promise<void> {
      clearTimeout(deadline)
      clearTimeout(flags.stall)
      signal.removeEventListener('abort', onAbort)
      flags.cancelled = true
      const settlements = await Promise.allSettled([handle.dispose(), result])
      const disposal = settlements[0]
      // The result channel owns run faults; disposal reports only failure to
      // release the published handle after both operations settle.
      if (disposal.status === 'rejected') throw disposal.reason
    },
  }
}

/** Read one settled child's result from events after its activation boundary. */
function readResult(
  child: Agent,
  boundary: SessionLogOffsetType,
  cancelled: boolean,
  structured?: { captured?: { value: unknown } | undefined },
): SubagentResult {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const own = child.session.snapshotEvents(boundary)
  // `droppedUnrun` is deliberately unread: a one-shot prompt is claimed by its
  // awaited first turn almost immediately, and the owner's own teardown is the
  // `cancelled` flag below. A cancellation with no accounting turn resolves
  // `error` through `toStopReason(undefined)`, which never overstates success.
  const lastEnd = foldConsumedWork(own).end
  // The seam's canonical selection rule; a partial answer survives cancel and truncation.
  const output: readonly ContentBlock[] = finalAssistantOutput(own) ?? []
  const recorded = toStopReason(lastEnd?.data.reason)
  // Disposal can tear the owner down before the loop records its ordinary
  // `aborted` end, yielding `disposed` instead.
  const stopReason: SubagentStopReason = cancelled && recorded !== 'completed' ? 'aborted' : recorded
  const reason = lastEnd?.data.reason
  const diagnostic = reason?.kind === 'error' ? failureDiagnostic(reason.error) : undefined
  if (structured !== undefined) {
    if (structured.captured !== undefined) {
      return { output, structured: structured.captured.value, stopReason }
    }
    if (stopReason === 'completed') return { output, stopReason: cancelled ? 'aborted' : 'error' }
  }
  return diagnostic === undefined ? { output, stopReason } : { output, stopReason, diagnostic }
}
