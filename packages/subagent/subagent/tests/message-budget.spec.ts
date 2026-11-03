import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBudget, messageLimitsFrom } from '../src/message-budget.ts'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SubagentMessageLimits } from '../src/types.ts'

let messages = 0

/** Deliver one parent message and let a turn claim it. */
function nextMessage(b: MessageBudget): void {
  const id = `parent-${messages += 1}` as MessageId
  b.admitted(id)
  b.claimed(id)
}

/** A budget whose inbox still holds every message except those in `gone`. */
function budget(limits: SubagentMessageLimits, gone: ReadonlySet<string> = new Set()) {
  const exceeded = vi.fn<(diagnostic: string) => void>()
  return { budget: new MessageBudget(limits, exceeded, id => !gone.has(id)), exceeded }
}

describe('MessageBudget', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }) })
  afterEach(() => { vi.useRealTimers() })

  describe('maxSteps', () => {
    it('admits the configured number of steps and refuses the next one', () => {
      const { budget: b, exceeded } = budget({ maxSteps: 2 })
      b.running()
      expect([b.stepEntered(), b.stepEntered()]).toEqual([true, true])
      expect(exceeded).not.toHaveBeenCalled()
      expect(b.stepEntered()).toBe(false)
      expect(exceeded).toHaveBeenCalledExactlyOnceWith('child stopped after its limit of 2 model steps')
      // Inert once spent: no further admissions and no second report.
      expect(b.stepEntered()).toBe(false)
      expect(exceeded).toHaveBeenCalledOnce()
    })

    it('restarts only when a turn claims the parent message, not when it is queued', () => {
      const { budget: b, exceeded } = budget({ maxSteps: 2 })
      b.running()
      b.stepEntered()
      // Queued behind the work still running for the first message.
      b.admitted('queued' as MessageId)
      b.stepEntered()
      expect(b.stepEntered()).toBe(false)
      expect(exceeded).toHaveBeenCalledOnce()
    })

    it('does not restart for a claimed message the parent did not send', () => {
      const { budget: b } = budget({ maxSteps: 1 })
      b.running()
      b.stepEntered()
      // e.g. an owned grandchild's settlement notice waking the child.
      b.claimed('grandchild-notice' as MessageId)
      expect(b.stepEntered()).toBe(false)
    })

    it('restarts the count for each parent message', () => {
      const { budget: b, exceeded } = budget({ maxSteps: 2 })
      b.running()
      b.stepEntered()
      b.stepEntered()
      nextMessage(b)
      expect([b.stepEntered(), b.stepEntered()]).toEqual([true, true])
      expect(exceeded).not.toHaveBeenCalled()
    })
  })

  describe('deadlineMs', () => {
    it('stops a child that keeps running past its deadline', () => {
      const { budget: b, exceeded } = budget({ deadlineMs: 100 })
      b.running()
      vi.advanceTimersByTime(99)
      expect(exceeded).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(exceeded).toHaveBeenCalledExactlyOnceWith('child stopped at its 100ms deadline')
    })

    it('counts only running time across idle gaps', () => {
      const { budget: b, exceeded } = budget({ deadlineMs: 100 })
      b.running()
      vi.advanceTimersByTime(60)
      b.idle()
      // Waiting on owned children or a parked inbox spends nothing.
      vi.advanceTimersByTime(10_000)
      expect(exceeded).not.toHaveBeenCalled()
      b.running()
      vi.advanceTimersByTime(39)
      expect(exceeded).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(exceeded).toHaveBeenCalledExactlyOnceWith('child stopped at its 100ms deadline')
    })

    it('gives each parent message the full deadline again', () => {
      const { budget: b, exceeded } = budget({ deadlineMs: 100 })
      b.running()
      vi.advanceTimersByTime(90)
      nextMessage(b)
      vi.advanceTimersByTime(99)
      expect(exceeded).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(exceeded).toHaveBeenCalledOnce()
    })

    it('gives a message delivered while idle the full deadline when the child next runs', () => {
      const { budget: b, exceeded } = budget({ deadlineMs: 100 })
      b.running()
      vi.advanceTimersByTime(90)
      b.idle()
      nextMessage(b)
      b.running()
      vi.advanceTimersByTime(99)
      expect(exceeded).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(exceeded).toHaveBeenCalledOnce()
    })
  })

  describe('stallMs', () => {
    it('stops a running child that starts no new step', () => {
      const { budget: b, exceeded } = budget({ stallMs: 50 })
      b.running()
      vi.advanceTimersByTime(50)
      expect(exceeded).toHaveBeenCalledExactlyOnceWith('child stopped: no new model step started for 50ms')
    })

    it('lets a slow child run on while it keeps starting steps', () => {
      const { budget: b, exceeded } = budget({ stallMs: 50 })
      b.running()
      for (let step = 0; step < 10; step += 1) {
        vi.advanceTimersByTime(40)
        b.stepProposed()
      }
      // 400ms in total, never 50ms without a new step.
      expect(exceeded).not.toHaveBeenCalled()
    })

    it('never stalls an idle child', () => {
      const { budget: b, exceeded } = budget({ stallMs: 50 })
      b.running()
      vi.advanceTimersByTime(40)
      b.idle()
      vi.advanceTimersByTime(1_800_000)
      expect(exceeded).not.toHaveBeenCalled()
      // Running again opens a fresh window rather than resuming the old one.
      b.running()
      vi.advanceTimersByTime(49)
      expect(exceeded).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(exceeded).toHaveBeenCalledOnce()
    })
  })

  describe('cancellation', () => {
    it('fires no limit while a cancellation unwinds, then resumes once the child is idle', () => {
      const { budget: b, exceeded } = budget({ maxSteps: 1, deadlineMs: 100, stallMs: 100 })
      b.running()
      vi.advanceTimersByTime(50)
      b.cancelled()
      // The aborted work may outlive every limit, and steps it still enters are not counted.
      vi.advanceTimersByTime(10_000)
      b.running()
      expect([b.stepEntered(), b.stepEntered()]).toEqual([true, true])
      expect(exceeded).not.toHaveBeenCalled()
      b.idle()
      // The deadline resumes from the 50ms spent before the cancellation.
      b.running()
      vi.advanceTimersByTime(49)
      expect(exceeded).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(exceeded).toHaveBeenCalledExactlyOnceWith('child stopped at its 100ms deadline')
    })

    it('ignores a cancellation that reaches an idle child', () => {
      const { budget: b, exceeded } = budget({ deadlineMs: 100 })
      b.cancelled()
      b.idle()
      b.running()
      vi.advanceTimersByTime(100)
      expect(exceeded).toHaveBeenCalledOnce()
    })
  })

  describe('queued parent messages', () => {
    it('counts accepted parent messages no turn claimed yet in the diagnostic', () => {
      const one = budget({ maxSteps: 1 })
      one.budget.running()
      one.budget.admitted('queued-1' as MessageId)
      one.budget.stepEntered()
      one.budget.stepEntered()
      expect(one.exceeded).toHaveBeenCalledExactlyOnceWith(
        'child stopped after its limit of 1 model steps; 1 queued message was discarded unread',
      )

      const two = budget({ stallMs: 10 })
      two.budget.running()
      two.budget.admitted('queued-1' as MessageId)
      two.budget.admitted('queued-2' as MessageId)
      vi.advanceTimersByTime(10)
      expect(two.exceeded).toHaveBeenCalledExactlyOnceWith(
        'child stopped: no new model step started for 10ms; 2 queued messages were discarded unread',
      )
    })

    it('counts only messages still pending in the inbox', () => {
      // `withdrawn` left the inbox; `rejected` was recorded but its delivery threw.
      const { budget: b, exceeded } = budget({ maxSteps: 1 }, new Set(['withdrawn', 'rejected']))
      b.running()
      b.admitted('withdrawn' as MessageId)
      b.admitted('rejected' as MessageId)
      b.admitted('queued' as MessageId)
      b.stepEntered()
      b.stepEntered()
      expect(exceeded).toHaveBeenCalledExactlyOnceWith(
        'child stopped after its limit of 1 model steps; 1 queued message was discarded unread',
      )
    })

    it('restarts the budget for a parent message claimed while the child is idle', () => {
      const { budget: b, exceeded } = budget({ deadlineMs: 100 })
      b.running()
      vi.advanceTimersByTime(90)
      b.idle()
      b.admitted('next' as MessageId)
      b.claimed('next' as MessageId)
      b.running()
      vi.advanceTimersByTime(99)
      expect(exceeded).not.toHaveBeenCalled()
    })
  })

  it('opens no stall window for a step proposed while idle', () => {
    const { budget: b, exceeded } = budget({ stallMs: 10 })
    b.stepProposed()
    vi.advanceTimersByTime(100)
    expect(exceeded).not.toHaveBeenCalled()
  })

  it('reports only the first limit reached', () => {
    const { budget: b, exceeded } = budget({ deadlineMs: 30, stallMs: 30 })
    b.running()
    vi.advanceTimersByTime(1_000)
    expect(exceeded).toHaveBeenCalledOnce()
  })

  it('is inert after stop', () => {
    const { budget: b, exceeded } = budget({ maxSteps: 1, deadlineMs: 30, stallMs: 30 })
    b.running()
    b.stop()
    vi.advanceTimersByTime(1_000)
    b.admitted('late' as MessageId)
    nextMessage(b)
    b.running()
    vi.advanceTimersByTime(1_000)
    expect(b.stepEntered()).toBe(false)
    expect(exceeded).not.toHaveBeenCalled()
  })
})

describe('messageLimitsFrom', () => {
  it('keeps only configured limits', () => {
    expect(messageLimitsFrom({ maxSteps: 200, stallMs: 1_800_000 })).toEqual({ maxSteps: 200, stallMs: 1_800_000 })
    expect(Object.keys(messageLimitsFrom({ maxSteps: 3 }) ?? {})).toEqual(['maxSteps'])
  })

  it('returns undefined when no limit is configured', () => {
    expect(messageLimitsFrom({})).toBeUndefined()
  })
})
