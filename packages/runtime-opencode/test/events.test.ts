import { test, expect } from "bun:test"
import { createEventTranslator, rawSessionId } from "../src/events.ts"

test("session.status 归一化三态，未知状态丢弃", () => {
  const { translate } = createEventTranslator()
  expect(translate({ type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } }))
    .toEqual([{ type: "session-status", sessionId: "s1", status: "busy" }])
  expect(translate({ type: "session.status", properties: { sessionID: "s1", status: { type: "retry" } } }))
    .toEqual([{ type: "session-status", sessionId: "s1", status: "retry" }])
  expect(translate({ type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } }))
    .toEqual([{ type: "session-status", sessionId: "s1", status: "idle" }])
  expect(translate({ type: "session.status", properties: { sessionID: "s1", status: { type: "weird" } } })).toEqual([])
  expect(translate({ type: "session.status", properties: { status: { type: "busy" } } })).toEqual([])
})

test("delta 有先后顺序依赖：先 message.updated 再 part.updated 才能产出文本", () => {
  const { translate } = createEventTranslator()
  // 顺序不对时（角色未知）直接丢弃
  expect(translate({ type: "message.part.delta", properties: { sessionID: "s", messageID: "m1", partID: "p1", delta: "hi" } })).toEqual([])
  translate({ type: "message.updated", properties: { sessionID: "s", info: { id: "m1", role: "assistant" } } })
  translate({ type: "message.part.updated", properties: { sessionID: "s", part: { id: "p1", type: "text" } } })
  expect(translate({ type: "message.part.delta", properties: { sessionID: "s", messageID: "m1", partID: "p1", delta: "hi" } }))
    .toEqual([{ type: "text-delta", sessionId: "s", text: "hi" }])
})

test("reasoning 映射为 thinking-delta，未登记 part 默认 text", () => {
  const { translate } = createEventTranslator()
  translate({ type: "message.updated", properties: { info: { id: "m", role: "assistant" } } })
  translate({ type: "message.part.updated", properties: { part: { id: "pr", type: "reasoning" } } })
  expect(translate({ type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "pr", delta: "…" } }))
    .toEqual([{ type: "thinking-delta", sessionId: "s", text: "…" }])
  expect(translate({ type: "message.part.delta", properties: { sessionID: "s", messageID: "m", partID: "unseen", delta: "x" } }))
    .toEqual([{ type: "text-delta", sessionId: "s", text: "x" }])
})

test("user 角色的 delta 被忽略，空 delta 也忽略", () => {
  const { translate } = createEventTranslator()
  translate({ type: "message.updated", properties: { info: { id: "u", role: "user" } } })
  expect(translate({ type: "message.part.delta", properties: { sessionID: "s", messageID: "u", partID: "p", delta: "x" } })).toEqual([])
  translate({ type: "message.updated", properties: { info: { id: "a", role: "assistant" } } })
  expect(translate({ type: "message.part.delta", properties: { sessionID: "s", messageID: "a", partID: "p", delta: "" } })).toEqual([])
})

test("tool part 的 running/error 产出 tool 事件，completed 只登记类型", () => {
  const { translate } = createEventTranslator()
  expect(translate({ type: "message.part.updated", properties: { sessionID: "s", part: { id: "t", type: "tool", tool: "bash", state: { status: "running" } } } }))
    .toEqual([{ type: "tool", sessionId: "s", name: "bash", status: "running", error: undefined }])
  expect(translate({ type: "message.part.updated", properties: { sessionID: "s", part: { id: "t", type: "tool", tool: "bash", state: { status: "error", error: "boom" } } } }))
    .toEqual([{ type: "tool", sessionId: "s", name: "bash", status: "error", error: "boom" }])
  expect(translate({ type: "message.part.updated", properties: { sessionID: "s", part: { id: "t2", type: "tool", tool: "bash", state: { status: "completed" } } } }))
    .toEqual([])
})

test("question.asked 原样透出请求", () => {
  const { translate } = createEventTranslator()
  const request = { id: "q", sessionID: "s", questions: [] }
  expect(translate({ type: "question.asked", properties: request }))
    .toEqual([{ type: "question", sessionId: "s", request }])
})

test("会话归属兼容 sessionID / info / part 三种落点", () => {
  expect(rawSessionId({ info: { sessionID: "a" } })).toBe("a")
  expect(rawSessionId({ part: { sessionID: "b" } })).toBe("b")
  expect(rawSessionId({ sessionID: "c" })).toBe("c")
  expect(rawSessionId({})).toBeUndefined()
})

test("未知事件类型被忽略", () => {
  const { translate } = createEventTranslator()
  expect(translate({ type: "server.connected", properties: {} })).toEqual([])
  expect(translate({ type: "file.edited", properties: { sessionID: "s" } })).toEqual([])
})
