/**
 * The in-process SPAWN subagent backend: registers a {@link SubagentProvider} on
 * `ctx.subagents` that runs each child as a fresh child {@link Agent} on the same cordis
 * context (its own session, own system prompt, zero parent context). The cheapest transport,
 * reusing the agent factory's quiescent teardown.
 * @module @deepseek-ai/dsh-subagent-spawn-in-process
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  ContinuableCreateSpec,
  SubagentCapabilities,
  SubagentMessageLimits,
  SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import { messageLimitsFrom } from '@deepseek-ai/dsh-subagent'

export const name = 'subagent-spawn-in-process'
// `tools` is deliberately not injected: the child factory already provides it during setup,
// and adding it here would unnecessarily change this provider's apply timing.
export const inject = ['subagents']

/** Config: the registry name to register the provider under. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `spawn`). */
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
  providerName: z.string().default('spawn'),
  maxSteps: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  deadlineMs: z.number().step(1).min(1).max(2 ** 31 - 1),
  stallMs: z.number().step(1).min(1).max(2 ** 31 - 1),
})

/**
 * The spawn provider. Supports every start-time capability: `depthLimit` (it
 * constructs the child, so it can enforce a recursion cap), `outputSchema`
 * (the scoped structured runtime), `agentOptions` (merged over the parent
 * route). The selected preset owns persona and tool composition.
 */
class SpawnInProcessProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    agentPreset: true,
    outputSchema: true,
    depthLimit: true,
  }
  // Context contract: a spawned child starts fresh — it never sees the parent conversation.
  readonly inheritsParentContext = false

  constructor(readonly name: string, readonly messageLimits: SubagentMessageLimits | undefined) {}

  prepareContinuable(): Promise<ContinuableCreateSpec> {
    // A spawned child starts fresh, so it contributes no seed; the continuation
    // manager owns every later operation on it.
    return Promise.resolve({})
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.subagents.registerProvider(new SpawnInProcessProvider(config.providerName, messageLimitsFrom(config)))
}
