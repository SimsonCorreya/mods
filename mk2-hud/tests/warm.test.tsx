import { expect, mock, test } from 'claude-code/testing'

import { HOLD, STATS, WARM } from '../hooks/state'
import { WARM_MARK, currentLimits, isPauseStale, isPingDue, isPingText, pauseFor, triggerPoint } from '../hooks/warm'

const LIMITS = { limit: 50, weekLimit: 40, limitResetsAt: 1_000, weekResetsAt: 9_000 }

test('a ping goes out only near the cache expiry, while on and idle', async () => {
  const on = { ...WARM, status: 'on' as const }
  expect(isPingDue(on, 170, false)).toBe(true)
  // Plenty of cache left, or none at all: nothing to keep.
  expect(isPingDue(on, 900, false)).toBe(false)
  expect(isPingDue(on, 0, false)).toBe(false)
  expect(isPingDue(on, null, false)).toBe(false)
  // Claude is working, a ping is in flight, or keep-warm is off or paused.
  expect(isPingDue(on, 170, true)).toBe(false)
  expect(isPingDue({ ...on, isPinging: true }, 170, false)).toBe(false)
  expect(isPingDue(WARM, 170, false)).toBe(false)
  expect(isPingDue({ ...on, status: 'paused' }, 170, false)).toBe(false)
})

test('pinging pauses near the session or weekly limit, until that limit resets', async () => {
  expect(pauseFor(LIMITS)).toEqual({ isDue: false, until: null })
  expect(pauseFor({ ...LIMITS, limit: 98 })).toEqual({ isDue: true, until: 1_000 })
  expect(pauseFor({ ...LIMITS, weekLimit: 95.5 })).toEqual({ isDue: true, until: 9_000 })
  // Off a subscription there are no readings, and nothing to pause for.
  expect(pauseFor({ limit: null, weekLimit: null, limitResetsAt: null, weekResetsAt: null }).isDue).toBe(false)
})

test("a ping's turn is told from the person's by its marker", async () => {
  expect(isPingText(`The mk2-hud plugin sent a message: ${WARM_MARK} Cache keep-alive.`)).toBe(true)
  expect(isPingText('keep the cache warm please')).toBe(false)
})

test("the shield pauses where what is left just covers the hold's pings and the wrap-up", async () => {
  const HOUR = 60 * 60 * 1000
  const now = 1_000_000
  // No ping measured yet, or no reset time: the fixed point.
  expect(triggerPoint({ limitResetsAt: now + 2 * HOUR }, null, 85, now)).toBe(85)
  expect(triggerPoint({ limitResetsAt: null }, 1, 85, now)).toBe(85)
  // 2 hours to the reset: 3 pings at 1% each, plus 3% to wrap up.
  expect(triggerPoint({ limitResetsAt: now + 2 * HOUR }, 1, 85, now)).toBe(94)
  // A long conversation's costly pings move it earlier; it never goes below 50%.
  expect(triggerPoint({ limitResetsAt: now + 4.5 * HOUR }, 4, 85, now)).toBe(77)
  expect(triggerPoint({ limitResetsAt: now + 5 * HOUR }, 20, 85, now)).toBe(50)
  // The reset is close: only the wrap-up is kept back.
  expect(triggerPoint({ limitResetsAt: now - 1 }, 1, 85, now)).toBe(97)
})

test('once the session limit has reset, its old reading no longer counts', async () => {
  const resetAt = new Date(2026, 10, 17, 23, 50).getTime()
  const justAfter = new Date(2026, 10, 17, 23, 51).getTime()
  const stale = { limit: 99, weekLimit: 40, limitResetsAt: resetAt, weekResetsAt: resetAt + 86_400_000 }
  // Before the reset the near-full reading stands; a minute after, it is gone.
  expect(currentLimits(stale, resetAt - 60_000).limit).toBe(99)
  expect(currentLimits(stale, justAfter).limit).toBe(null)
  expect(currentLimits(stale, justAfter).weekLimit).toBe(40)
  expect(pauseFor(currentLimits(stale, justAfter)).isDue).toBe(false)
  // A pause from the old window is over; one with its reset still ahead is not.
  expect(isPauseStale({ status: 'pausing', pauseEndsAt: resetAt }, justAfter)).toBe(true)
  expect(isPauseStale({ status: 'pausing', pauseEndsAt: resetAt }, resetAt - 60_000)).toBe(false)
  expect(isPauseStale({ status: 'pausing', pauseEndsAt: null }, justAfter)).toBe(false)
})

for (const [when, now, isBlocked] of [
  ['before the reset, the shield blocks a tool call', 23 * 60 + 49, true],
  ['just after the reset, the shield lets a tool call through', 23 * 60 + 51, false],
] as const) {
  test(when, async ($, on) => {
    const resetAt = new Date(2026, 10, 17, 23, 50).getTime()
    mock.clock(on, { now: new Date(2026, 10, 17, 0, now).getTime() })
    // Paused near the limit in the window that resets at 11:50 pm.
    const hold = { ...HOLD, status: 'pausing' as const, pauseEndsAt: resetAt }
    const stats = { ...STATS, limit: 99, limitResetsAt: resetAt }
    on('state.get', ($, e, next) => {
      const key = (e as { key?: string }).key
      if (key === 'hold') return { value: { value: hold, version: 1 } }
      if (key === 'stats') return { value: { value: stats, version: 1 } }
      return next(e)
    })
    on('tool.call', () => ({ result: {} }))
    const result = await $.tool.call({ tool: 'Bash', command: 'ls' })
    const text = JSON.stringify(result)
    if (isBlocked) expect(text).toContain('shield')
    else expect(text).not.toContain('shield')
  })
}
