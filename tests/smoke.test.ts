import { describe, expect, test } from 'bun:test'

describe('test harness', () => {
  test('bun:test runs', () => {
    expect(1 + 1).toBe(2)
  })
})
