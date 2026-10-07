import test from 'node:test'
import assert from 'node:assert/strict'
import { add } from './calculator.mjs'
test('adds positive operands', () => assert.equal(add(2, 3), 5))
test('adds negative operands', () => assert.equal(add(-2, 5), 3))
test('handles zero', () => assert.equal(add(0, 7), 7))
