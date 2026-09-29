import { test, expect } from "bun:test"
import { canDrainQueue, sessionIsActive, abortedTailMessageId } from "../public/runtime-status.js"

const busy = new Map([["s1", { status: "busy" }]])

test("active 只有状态可用且会话在 busy 集合里才成立", () => {
  expect(sessionIsActive("s1", busy, true)).toBe(true)
  expect(sessionIsActive("s2", busy, true)).toBe(false)
  expect(sessionIsActive("s1", busy, false)).toBe(false)
  expect(sessionIsActive(undefined, busy, true)).toBe(false)
})

test("状态不可用时不续发：拿不到权威状态就不猜", () => {
  expect(canDrainQueue({
    statusAvailable: false, runtimeStatus: new Map(), sessionId: "s1", queueLength: 1,
  })).toBe(false)
})

test("状态可用且会话空闲才续发", () => {
  expect(canDrainQueue({
    statusAvailable: true, runtimeStatus: new Map(), sessionId: "s1", queueLength: 1,
  })).toBe(true)
})

test("会话 busy / 正在发送 / 无排队消息都不续发", () => {
  expect(canDrainQueue({
    statusAvailable: true, runtimeStatus: busy, sessionId: "s1", queueLength: 1,
  })).toBe(false)
  expect(canDrainQueue({
    statusAvailable: true, runtimeStatus: new Map(), sessionId: "s1", sending: true, queueLength: 1,
  })).toBe(false)
  expect(canDrainQueue({
    statusAvailable: true, runtimeStatus: new Map(), sessionId: "s1", queueLength: 0,
  })).toBe(false)
})

test("空闲下未完成的尾部助手消息标为已中断", () => {
  const messages = [{ id: "u1", role: "user" }, { id: "a1", role: "assistant" }]
  expect(abortedTailMessageId(messages, { statusAvailable: true })).toBe("a1")
})

test("运行中 / 发送中 / 有待答问题 / 状态不可用都不标记", () => {
  const messages = [{ id: "a1", role: "assistant" }]
  expect(abortedTailMessageId(messages, { statusAvailable: true, active: true })).toBeNull()
  expect(abortedTailMessageId(messages, { statusAvailable: true, sending: true })).toBeNull()
  expect(abortedTailMessageId(messages, { statusAvailable: true, hasQuestion: true })).toBeNull()
  expect(abortedTailMessageId(messages, { statusAvailable: false })).toBeNull()
})

test("已完成的尾部助手消息、尾部用户消息与空列表都不标记", () => {
  expect(abortedTailMessageId([{ id: "a1", role: "assistant", finish: "stop", completedAt: 1 }], { statusAvailable: true })).toBeNull()
  expect(abortedTailMessageId([{ id: "u1", role: "user" }], { statusAvailable: true })).toBeNull()
  expect(abortedTailMessageId([], { statusAvailable: true })).toBeNull()
})
