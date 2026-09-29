import { test, expect } from "bun:test"
import { classifySendFailure } from "../public/send-recovery.js"

test("歧义失败：已写入但未完成 → persisted 且 needsReplySync", () => {
  const messages = [
    { id: "u0", role: "user", text: "old" },
    { id: "u1", role: "user", text: "hi" },
  ]
  expect(classifySendFailure(messages, { text: "hi", knownMessageIds: new Set(["u0"]) }))
    .toEqual({ latestUserIndex: 1, persisted: true, recovered: false, needsReplySync: true })
})

test("歧义失败：已写入且已有完成回复 → recovered，不重读", () => {
  const messages = [
    { id: "u0", role: "user", text: "old" },
    { id: "u1", role: "user", text: "hi" },
    { id: "a1", role: "assistant", text: "reply", finish: "stop", completedAt: 123 },
  ]
  const result = classifySendFailure(messages, { text: "hi", knownMessageIds: new Set(["u0"]) })
  expect(result.persisted).toBe(true)
  expect(result.recovered).toBe(true)
  expect(result.needsReplySync).toBe(false)
})

test("真失败：未写入 → persisted=false，可恢复草稿", () => {
  const messages = [{ id: "u0", role: "user", text: "old" }]
  expect(classifySendFailure(messages, { text: "hi", knownMessageIds: new Set(["u0"]) }))
    .toEqual({ latestUserIndex: -1, persisted: false, recovered: false, needsReplySync: false })
})

test("发送前已存在的同文本消息不算本次写入", () => {
  const messages = [{ id: "u1", role: "user", text: "hi" }]
  expect(classifySendFailure(messages, { text: "hi", knownMessageIds: new Set(["u1"]) }).persisted).toBe(false)
})

test("斜杠命令不比较文本", () => {
  const messages = [{ id: "u1", role: "user", text: "/review --brief" }]
  expect(classifySendFailure(messages, { text: "/review --brief", commandMatch: true, knownMessageIds: new Set() }).persisted).toBe(true)
})

test("尾部未完成的助手消息不算 recovered", () => {
  const messages = [
    { id: "u1", role: "user", text: "hi" },
    { id: "a1", role: "assistant", text: "partial" },
  ]
  expect(classifySendFailure(messages, { text: "hi", knownMessageIds: new Set() }).recovered).toBe(false)
})
