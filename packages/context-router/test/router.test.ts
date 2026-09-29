import assert from "node:assert/strict"
import test from "node:test"
import {
  addLink,
  addNode,
  addWorkspace,
  emptyGraph,
  joinWorkspace,
  type GraphNode,
  type Workspace,
} from "@nodex/domain"
import { renderContext, routeContext, type ContextChunk } from "../src/router.ts"

const NOW = "2026-09-22T00:00:00.000Z"

function node(id: string, tokenCount = 300): GraphNode {
  return {
    id,
    kind: "session",
    title: id,
    category: "",
    categories: [],
    tags: [],
    lifecycle: "active",
    tokenCount,
    semantic: null,
    layouts: {},
    summaries: [],
    meta: {},
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function ws(id: string, systemPrompt = "", variables: Record<string, string> = {}): Workspace {
  return {
    id,
    name: id,
    systemPrompt,
    variables,
    flat: true,
    color: "#888",
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function baseGraph() {
  const g = emptyGraph()
  addNode(g, node("a"))
  addNode(g, node("b"))
  addNode(g, node("outside"))
  addWorkspace(g, ws("w1", "你是项目 A 的助手", { PROJECT: "A" }))
  addWorkspace(g, ws("w2", "你是项目 B 的助手", { PROJECT: "B" }))
  joinWorkspace(g, "w1", "a", NOW)
  joinWorkspace(g, "w1", "b", NOW)
  joinWorkspace(g, "w2", "outside", NOW)
  return g
}

const fullText = async (id: string) => `full-text-of-${id}`.repeat(20)

test("硬加载全量注入，且同圈节点可软加载", async () => {
  const graph = baseGraph()
  const retrieved: string[] = []
  const result = await routeContext({
    graph,
    activeNodeIds: ["a"],
    query: "q",
    tokenBudget: 100_000,
    fullTextOf: fullText,
    retrieve: async ({ workspaceId, excludeNodeIds }) => {
      retrieved.push(workspaceId)
      return [{ nodeId: "b", tier: "soft", text: "b-summary", tokens: 5, source: {}, trusted: true }]
        .filter((c) => !excludeNodeIds.includes(c.nodeId)) as ContextChunk[]
    },
  })

  const hard = result.chunks.filter((c) => c.tier === "hard")
  assert.equal(hard.length, 1)
  assert.match(hard[0].text, /^full-text-of-a/)
  assert.ok(result.chunks.some((c) => c.tier === "soft" && c.nodeId === "b"))
  assert.deepEqual(retrieved, ["w1"])
  assert.equal(result.systemPrompt, "你是项目 A 的助手")
  assert.deepEqual(result.variables, { PROJECT: "A" })
})

test("hardLoadActive=false 时跳过自身硬加载，但保留软加载范围与 system", async () => {
  const graph = baseGraph()
  const read: string[] = []
  const result = await routeContext({
    graph,
    activeNodeIds: ["a"],
    query: "q",
    tokenBudget: 100_000,
    hardLoadActive: false,
    fullTextOf: async (id) => {
      read.push(id)
      return `full-text-of-${id}`
    },
    retrieve: async () =>
      [{ nodeId: "b", tier: "soft", text: "b-summary", tokens: 5, source: {}, trusted: true }] as ContextChunk[],
  })
  assert.equal(result.chunks.filter((c) => c.tier === "hard").length, 0)
  assert.ok(!read.includes("a"), "不得读取激活节点自身全文")
  assert.ok(result.chunks.some((c) => c.nodeId === "b" && c.tier === "soft"))
  assert.equal(result.systemPrompt, "你是项目 A 的助手")
})

test("圈外节点即使被检索返回也会被隔离丢弃", async () => {
  const graph = baseGraph()
  const result = await routeContext({
    graph,
    activeNodeIds: ["a"],
    query: "q",
    tokenBudget: 100_000,
    fullTextOf: fullText,
    retrieve: async () =>
      [
        { nodeId: "outside", tier: "soft", text: "leak", tokens: 5, source: {}, trusted: true },
      ] as ContextChunk[],
  })
  assert.ok(!result.chunks.some((c) => c.nodeId === "outside"))
})

test("软加载内容被标记为不可信并渲染为 reference", async () => {
  const graph = baseGraph()
  const result = await routeContext({
    graph,
    activeNodeIds: ["a"],
    query: "q",
    tokenBudget: 100_000,
    fullTextOf: fullText,
    retrieve: async () =>
      [
        { nodeId: "b", tier: "soft", text: "note", tokens: 5, source: {}, trusted: true },
      ] as ContextChunk[],
  })
  const soft = result.chunks.find((c) => c.nodeId === "b")
  assert.equal(soft?.trusted, false)

  const rendered = renderContext(result)
  assert.match(rendered, /不可信参考资料/)
  assert.match(rendered, /<reference node="b" tier="soft"/)
})

test("Portal 只注入快照，不穿透目标节点全文", async () => {
  const graph = baseGraph()
  addLink(graph, {
    id: "l1",
    kind: "portal",
    from: "a",
    to: "outside",
    directed: true,
    snapshot: { text: "API 规范摘要", version: 3, createdAt: NOW },
    meta: {},
    createdAt: NOW,
  })

  const read: string[] = []
  const result = await routeContext({
    graph,
    activeNodeIds: ["a"],
    query: "q",
    tokenBudget: 100_000,
    fullTextOf: async (id) => {
      read.push(id)
      return `FULL-${id}`
    },
    retrieve: undefined,
  })

  const portal = result.chunks.find((c) => c.tier === "portal")
  assert.equal(portal?.nodeId, "outside")
  assert.equal(portal?.text, "API 规范摘要")
  assert.equal(portal?.source.summaryVersion, 3)
  assert.ok(!read.includes("outside"), "Portal 不得读取目标节点全文")
  assert.ok(!result.chunks.some((c) => c.text.includes("FULL-outside")))
})

test("无快照的 portal 链路被忽略", async () => {
  const graph = baseGraph()
  addLink(graph, {
    id: "l2",
    kind: "portal",
    from: "a",
    to: "outside",
    directed: true,
    meta: {},
    createdAt: NOW,
  })
  const result = await routeContext({
    graph,
    activeNodeIds: ["a"],
    query: "q",
    tokenBudget: 100_000,
    fullTextOf: fullText,
    retrieve: undefined,
  })
  assert.ok(!result.chunks.some((c) => c.nodeId === "outside"))
})

test("预算不足时硬加载优先，软加载进入 dropped", async () => {
  const graph = baseGraph()
  const result = await routeContext({
    graph,
    activeNodeIds: ["a"],
    query: "q",
    tokenBudget: 100,
    fullTextOf: async () => "x".repeat(150),
    retrieve: async () =>
      [{ nodeId: "b", tier: "soft", text: "y".repeat(300), tokens: 100, source: {}, trusted: true }] as ContextChunk[],
  })
  assert.equal(result.chunks.filter((c) => c.tier === "hard").length, 1)
  assert.ok(result.dropped.some((c) => c.nodeId === "b"))
  assert.ok(result.usedTokens >= 50)
})

test("交叠区节点同时继承两侧工作区背景", async () => {
  const graph = baseGraph()
  joinWorkspace(graph, "w2", "a", NOW)

  const result = await routeContext({
    graph,
    activeNodeIds: ["a"],
    query: "q",
    tokenBudget: 100_000,
    fullTextOf: fullText,
    retrieve: undefined,
  })

  assert.deepEqual(result.overlapNodeIds, ["a"])
  assert.match(result.systemPrompt, /项目 A/)
  assert.match(result.systemPrompt, /项目 B/)
  assert.equal(result.variables.PROJECT, "B")
})

test("未激活节点不产生任何内容", async () => {
  const graph = baseGraph()
  const result = await routeContext({
    graph,
    activeNodeIds: [],
    query: "q",
    tokenBudget: 100_000,
    fullTextOf: fullText,
    retrieve: undefined,
  })
  assert.equal(result.chunks.length, 0)
  assert.equal(result.usedTokens, 0)
})
