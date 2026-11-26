import { expect, test } from 'claude-code/testing'

import type { Flow, TaskItem } from '../types'
import { applyPlan, barFor, isPlanHeld, label, listFromAnswer, wrappedBar } from '../hooks/mission'

const LIST = {
  items: [
    { content: 'Read the code', status: 'completed' },
    { content: 'Build it', status: 'in_progress' },
    { content: 'Test it', status: 'pending' },
    { content: 'Ship it', status: 'pending' },
  ],
}

const statuses = (items: TaskItem[]) => items.map(t => t.status)

const plan = (over: Partial<Flow> = {}): Flow => ({
  title: 'My plan',
  total: 6,
  done: 2,
  running: 0,
  phase: 'delegate',
  isFinished: false,
  tasks: [],
  source: 'plan',
  reportedAt: 100,
  ...over,
})

test('a whole list sets the tasks, the total and the done count', async () => {
  const items = applyPlan([], LIST)
  expect(items.map(t => t.subject)).toEqual(['Read the code', 'Build it', 'Test it', 'Ship it'])
  const f = barFor(null, items, 0)
  expect(f?.source).toBe('tasks')
  expect(f?.total).toBe(4)
  expect(f?.done).toBe(1)
  expect(f?.title).toBe('Build it')
  expect(label(f as Flow)).toBe('Tasks 1/4')
})

test('advance finishes the step in progress and starts the next', async () => {
  const items = applyPlan(applyPlan([], LIST), { advance: true })
  expect(statuses(items)).toEqual(['completed', 'completed', 'in_progress', 'pending'])
  // Past the last step every step is done, and the bar is full.
  const end = applyPlan(applyPlan(items, { advance: true }), { advance: true })
  expect(statuses(end)).toEqual(['completed', 'completed', 'completed', 'completed'])
  expect(barFor(null, end, 0)?.isFinished).toBe(true)
})

test('done and start mark steps by their 1-based numbers', async () => {
  const items = applyPlan(applyPlan([], LIST), { done: [2, 3], start: 4 })
  expect(statuses(items)).toEqual(['completed', 'completed', 'completed', 'in_progress'])
  // Numbers out of range change nothing.
  expect(statuses(applyPlan(items, { done: [0, 9], start: 7 }))).toEqual(statuses(items))
})

test('wrap_up fills the bar, unless the turn waits on the person', async () => {
  const f = barFor(null, applyPlan([], LIST), 0)
  expect(wrappedBar(f, false)?.isFinished).toBe(true)
  expect(wrappedBar(f, false)?.done).toBe(4)
  expect(wrappedBar(f, true)).toBe(f)
  expect(wrappedBar(null, false)).toBe(null)
})

test('a new task replaces a finished or older bar', async () => {
  const old = barFor(null, applyPlan([], LIST), 0)
  const fresh = applyPlan([], { items: [{ content: 'Other job', status: 'in_progress' }], scope: 'new_task' })
  const f = barFor(old, fresh, 500, true)
  expect(f?.total).toBe(1)
  expect(f?.title).toBe('Other job')
  // An unfinished plan from an earlier turn gives way to the new task too.
  expect(barFor(plan({ reportedAt: 100 }), fresh, 500, true)?.source).toBe('tasks')
})

test('a plan reported with the progress tool wins over the task list', async () => {
  const items = applyPlan([], LIST)
  const p = plan()
  // Under way: the task list never replaces it, from any turn.
  expect(barFor(p, items, 500)).toBe(p)
  expect(barFor(p, items, 50)).toBe(p)
  // Reported this turn: it wins even over a new task, and still once finished.
  expect(barFor(p, items, 50, true)).toBe(p)
  const done = plan({ isFinished: true, done: 6 })
  expect(isPlanHeld(done, 50)).toBe(true)
  expect(barFor(done, items, 50)).toBe(done)
  // Finished in an earlier turn: the task list takes the bar again.
  expect(isPlanHeld(done, 500)).toBe(false)
  expect(barFor(done, items, 500)?.source).toBe('tasks')
})

test('the bar only ever shows one count', async () => {
  const p = plan()
  let items = applyPlan([], LIST)
  let bar = barFor(p, items, 50)
  for (const step of [{ advance: true }, { done: [3], start: 4 }, { advance: true }]) {
    items = applyPlan(items, step)
    bar = barFor(bar, items, 50)
    expect(bar?.total).toBe(6)
    expect(bar?.source).toBe('plan')
  }
})

test("a list the mod never saw is rebuilt from the app's answer", async () => {
  const items = listFromAnswer('Plan updated: step 3 of 4 is in progress.')
  expect(statuses(items)).toEqual(['completed', 'completed', 'in_progress', 'pending'])
  expect(barFor(null, items, 0)?.done).toBe(2)
  // Content blocks work too; an answer without a count gives nothing.
  expect(listFromAnswer([{ type: 'text', text: 'step 1 of 2' }])).toHaveLength(2)
  expect(listFromAnswer('Plan shown (4 steps).')).toEqual([])
  expect(listFromAnswer('step 5 of 4')).toEqual([])
})
