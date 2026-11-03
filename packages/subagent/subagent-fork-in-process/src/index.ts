/**
 * The in-process FORK subagent backend: registers a {@link SubagentProvider} on
 * `ctx.subagents` that runs each child as a child {@link Agent} SEEDED with a prefix of the
 * parent's session log — so the child inherits the parent's conversation context instead of
 * starting fresh. The seed ends at the last `turn/end`: the current tool-call turn is
 * unbalanced and cannot be replayed as a valid child session.
 * @module @deepseek-ai/dsh-subagent-fork-in-process
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  ContinuableCreateRequest,
  ContinuableCreateSpec,
  SubagentCapabilities,
  SubagentMessageLimits,
  SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { messageLimitsFrom } from '@deepseek-ai/dsh-subagent'

export const name = 'subagent-fork-in-process'
// `tools` is deliberately NOT injected — same rationale as subagent-spawn-in-process: the
// per-run structured runtime gates its capture-tool registration on `tools`
// itself, so this backend's apply timing (and the delegation tool's position
// in the model-visible tool list) is unchanged by structured output.
export const inject = ['subagents']

/** Config: the registry name to register the provider under. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `fork`). */
  providerName: string
  /** Most model steps one child may enter after each parent message; omit for no step cap. */
  maxSteps?: number
  /**
   * Running milliseconds one child may spend after each parent message before it
   * is stopped; idle time does not count. Omit for no deadline.
   */
  deadlineMs?: number
  /** Running milliseconds one child may go without starting a model step before it is stopped; omit for no stall limit. */
  stallMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('fork'),
  maxSteps: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  deadlineMs: z.number().step(1).min(1).max(2 ** 31 - 1),
  stallMs: z.number().step(1).min(1).max(2 ** 31 - 1),
})

/**
 * The balanced completed-turn prefix of `parent`'s log: every event up to and including the
 * last `turn/end`. The in-flight turn is excluded; before any completed turn the child starts
 * fresh. Because live sequence numbers equal array indexes, the result remains a valid seed
 * beginning at sequence zero.
 * @param parent - the agent whose session log to slice.
 * @returns the seed events, contiguous from seq 0; empty when no turn has completed.
 */
function completedTurnPrefix(parent: Agent): SessionEvent[] {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const events = parent.session.snapshotEvents()
  const lastEnd = events.findLast(e => e.type === 'turn/end')
  if (lastEnd === undefined) return []
  // seq === array index (the append contract), so slice up to and including it.
  return events.slice(0, lastEnd.seq + 1)
}

/**
 * The fork provider. Supports `depthLimit` and `outputSchema` (via the shared
 * in-process structured runtime), `agentOptions` (merged over the parent
 * route). The child inherits its parent's preset composition.
 */
class ForkInProcessProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    agentPreset: false,
    outputSchema: true,
    depthLimit: true,
  }
  // Context contract: a forked child IS seeded with the parent's completed-turn prefix.
  readonly inheritsParentContext = true

  constructor(readonly name: string, readonly messageLimits: SubagentMessageLimits | undefined) {}

  prepareContinuable(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec> {
    // The fork prefix is captured ONCE, at creation: it becomes part of the
    // child's own durable transcript, so a later cold resume replays that
    // prefix instead of re-forking the parent's newer history.
    const seed = completedTurnPrefix(request.parent)
    return Promise.resolve(seed.length > 0 ? { seed } : {})
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new ForkInProcessProvider(config.providerName, messageLimitsFrom(config)))
}
