import test from 'node:test'
import assert from 'node:assert/strict'
test('synthetic once-only transient failure, succeeds on next real iteration', () => {
  assert.ok(Number(process.env.GOAL_ITERATION) > 1, 'Synthetic first-iteration transient failure: retry the unchanged immutable checks')
})
