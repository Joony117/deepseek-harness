import { describe, expect, it } from 'vitest'
import { CallId, ToolCallId } from '../src/brand.ts'

describe('tool call id compatibility', () => {
  it('keeps the pre-rename CallId export available to provider plugins', () => {
    expect(CallId('provider-call')).toBe(ToolCallId('provider-call'))
  })
})
