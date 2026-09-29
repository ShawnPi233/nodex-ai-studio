import { test, expect } from "bun:test"
import { OpencodeRuntime } from "../src/opencode-runtime.ts"
import type { NodexEvent } from "../src/events.ts"

/** 可手动 push 的假事件流，模拟 OpenCode SSE。 */
function pushableStream() {
  const queue: any[] = []
  let resolveNext: ((r: IteratorResult<any>) => void) | null = null
  let closed = false
  const stream: AsyncIterable<any> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<any>> {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => { resolveNext = resolve })
        },
        return(): Promise<IteratorResult<any>> {
          closed = true
          resolveNext?.({ value: undefined, done: true })
          resolveNext = null
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
  return {
    stream,
    push(value: any) {
      if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value, done: false }) }
      else queue.push(value)
    },
  }
}

function runtimeWithStream() {
  const s = pushableStream()
  let subscribeCalls = 0
  const client = {
    session: {},
    event: { subscribe: async () => { subscribeCalls++; return { stream: s.stream } } },
  }
  const runtime = new OpencodeRuntime({ client: client as any })
  return { runtime, push: s.push, calls: () => subscribeCalls }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const status = (mode: string) => ({ type: "session.status", properties: { sessionID: "s", status: { type: mode } } })

test("多个订阅者共享同一条上游连接", async () => {
  const { runtime, push, calls } = runtimeWithStream()
  const a: NodexEvent[] = []
  const b: NodexEvent[] = []
  const offA = await runtime.subscribe((e) => a.push(e))
  const offB = await runtime.subscribe((e) => b.push(e))
  expect(calls()).toBe(1)
  push(status("busy"))
  await tick()
  expect(a).toEqual([{ type: "session-status", sessionId: "s", status: "busy" }])
  expect(b).toEqual([{ type: "session-status", sessionId: "s", status: "busy" }])
  offA()
  push(status("idle"))
  await tick()
  expect(a.length).toBe(1)
  expect(b.length).toBe(2)
  offB()
})

test("全部退订后再次订阅会重新建连", async () => {
  const { runtime, calls } = runtimeWithStream()
  const off = await runtime.subscribe(() => {})
  expect(calls()).toBe(1)
  off()
  await runtime.subscribe(() => {})
  expect(calls()).toBe(2)
})

test("单个订阅者抛错不影响其它订阅者", async () => {
  const { runtime, push } = runtimeWithStream()
  const got: NodexEvent[] = []
  await runtime.subscribe(() => { throw new Error("boom") })
  await runtime.subscribe((e) => got.push(e))
  push(status("busy"))
  await tick()
  expect(got).toEqual([{ type: "session-status", sessionId: "s", status: "busy" }])
})
