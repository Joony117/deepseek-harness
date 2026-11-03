/**
 * Per-message execution limits for one local child Activation.
 * @module
 */

import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SubagentMessageLimits } from './types.ts'

/**
 * Build the limits a provider configured, omitting every unset field.
 * @param config - provider config carrying the optional limit fields.
 * @returns the configured limits, or undefined when none is set.
 */
export function messageLimitsFrom(config: SubagentMessageLimits): SubagentMessageLimits | undefined {
  const { maxSteps, deadlineMs, stallMs } = config
  if (maxSteps === undefined && deadlineMs === undefined && stallMs === undefined) return undefined
  return {
    ...maxSteps === undefined ? {} : { maxSteps },
    ...deadlineMs === undefined ? {} : { deadlineMs },
    ...stallMs === undefined ? {} : { stallMs },
  }
}

/**
 * Enforces one local child's {@link SubagentMessageLimits}. The step count,
 * the deadline, and the stall window restart when a turn claims a parent
 * message, so work still running for an earlier message never spends the next
 * message's budget, and messages from the child's own children never restart
 * it. Time is counted only while the child runs: time idle waiting on owned
 * children or with a parked inbox neither stalls the child nor spends its
 * deadline. While a cancellation someone else requested unwinds, no limit
 * fires. The first limit reached calls `onExceeded` once with the
 * parent-visible diagnostic, which also counts the accepted parent messages
 * no turn claimed yet; the budget is inert after that or after {@link stop}.
 */
export class MessageBudget {
  private steps = 0
  private spentMs = 0
  private runningSince: number | undefined
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined
  private stallTimer: ReturnType<typeof setTimeout> | undefined
  private done = false
  private suspended = false
  private readonly parentMessages = new Set<MessageId>()

  /**
   * @param limits - the provider's configured limits.
   * @param onExceeded - called once with the diagnostic of the first limit reached.
   */
  constructor(
    private readonly limits: SubagentMessageLimits,
    private readonly onExceeded: (diagnostic: string) => void,
  ) {}

  /**
   * Record a parent message just accepted for the child.
   * @param messageId - the accepted message; its claim restarts the budget.
   */
  admitted(messageId: MessageId): void {
    if (!this.done) this.parentMessages.add(messageId)
  }

  /**
   * A turn claimed one inbox message; a parent message starts a fresh budget.
   * @param messageId - the claimed message.
   */
  claimed(messageId: MessageId): void {
    if (!this.parentMessages.delete(messageId)) return
    this.steps = 0
    this.spentMs = 0
    if (this.runningSince === undefined) return
    this.runningSince = performance.now()
    this.armDeadline()
    this.armStall()
  }

  /**
   * The inbox dropped one message before any turn claimed it.
   * @param messageId - the discarded message.
   */
  discarded(messageId: MessageId): void {
    this.parentMessages.delete(messageId)
  }

  /** The child started running: resume the deadline and open a stall window. */
  running(): void {
    if (this.done || this.suspended || this.runningSince !== undefined) return
    this.runningSince = performance.now()
    this.armDeadline()
    this.armStall()
  }

  /** The child went idle: bank its running time, pause both timers, and end any suspension. */
  idle(): void {
    this.pause()
    this.suspended = false
  }

  /** A cancellation of the running work began: no limit fires until the child is idle again. */
  cancelled(): void {
    this.pause()
    this.suspended = true
  }

  /** A model step is being proposed: its start resets the stall window. */
  stepProposed(): void {
    if (this.runningSince !== undefined) this.armStall()
  }

  /**
   * Count one entered model step.
   * @returns whether the step may run; false once it exceeds `maxSteps`.
   */
  stepEntered(): boolean {
    if (this.done) return false
    if (this.suspended) return true
    this.steps += 1
    const { maxSteps } = this.limits
    if (maxSteps === undefined || this.steps <= maxSteps) return true
    this.exceed(`child stopped after its limit of ${maxSteps} model steps`)
    return false
  }

  /** Disarm permanently; the owning Activation is closing. */
  stop(): void {
    this.done = true
    this.runningSince = undefined
    this.parentMessages.clear()
    this.clearTimers()
  }

  private pause(): void {
    if (this.runningSince === undefined) return
    this.spentMs += performance.now() - this.runningSince
    this.runningSince = undefined
    this.clearTimers()
  }

  private armDeadline(): void {
    const { deadlineMs } = this.limits
    if (deadlineMs === undefined) return
    clearTimeout(this.deadlineTimer)
    this.deadlineTimer = setTimeout(() => {
      this.exceed(`child stopped at its ${deadlineMs}ms deadline`)
    }, Math.max(0, deadlineMs - this.spentMs))
  }

  private armStall(): void {
    const { stallMs } = this.limits
    if (stallMs === undefined) return
    clearTimeout(this.stallTimer)
    this.stallTimer = setTimeout(() => {
      this.exceed(`child stopped: no new model step started for ${stallMs}ms`)
    }, stallMs)
  }

  private clearTimers(): void {
    clearTimeout(this.deadlineTimer)
    clearTimeout(this.stallTimer)
    this.deadlineTimer = undefined
    this.stallTimer = undefined
  }

  /** Report the first limit reached; callers only reach this while live and unsuspended. */
  private exceed(limit: string): void {
    const unread = this.parentMessages.size
    this.stop()
    this.onExceeded(unread === 0
      ? limit
      : `${limit}; ${unread} queued message${unread === 1 ? ' was' : 's were'} discarded unread`)
  }
}
