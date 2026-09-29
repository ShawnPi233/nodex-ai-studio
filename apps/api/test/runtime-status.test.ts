import { test, expect } from "bun:test"
import { isSessionActive } from "../src/runtime-status.ts"

test("busy 与 retry 都算活跃", () => {
  expect(isSessionActive({ type: "busy" })).toBe(true)
  // 重试中若被判空闲，会误续发队列 / 触发补标题
  expect(isSessionActive({ type: "retry" })).toBe(true)
})

test("idle、未知与缺失都不算活跃", () => {
  expect(isSessionActive({ type: "idle" })).toBe(false)
  expect(isSessionActive({ type: "something-else" })).toBe(false)
  expect(isSessionActive({})).toBe(false)
  expect(isSessionActive(undefined)).toBe(false)
  expect(isSessionActive(null)).toBe(false)
})
