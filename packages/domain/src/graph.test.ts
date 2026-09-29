import assert from "node:assert/strict"
import test from "node:test"
import {
  addNode,
  addWorkspace,
  emptyGraph,
  joinWorkspace,
  leaveWorkspace,
  nodeRadius,
  overlapNodes,
  workspacesOf,
} from "./graph.ts"
import type { GraphNode, Workspace } from "./types.ts"

const NOW = "2026-09-22T00:00:00.000Z"

function node(id: string, tokenCount = 1000): GraphNode {
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

function workspace(id: string): Workspace {
  return {
    id,
    name: id,
    systemPrompt: "",
    variables: {},
    flat: true,
    color: "#888",
    createdAt: NOW,
    updatedAt: NOW,
  }
}

test("拖入工作区继承归属，拖出后剥离", () => {
  const g = emptyGraph()
  addNode(g, node("a"))
  addWorkspace(g, workspace("w1"))

  joinWorkspace(g, "w1", "a", NOW)
  assert.deepEqual(workspacesOf(g, "a"), ["w1"])

  leaveWorkspace(g, "w1", "a")
  assert.deepEqual(workspacesOf(g, "a"), [])
})

test("重复加入同一工作区不产生重复成员", () => {
  const g = emptyGraph()
  addNode(g, node("a"))
  joinWorkspace(g, "w1", "a", NOW)
  joinWorkspace(g, "w1", "a", NOW)
  assert.equal(g.members.length, 1)
})

test("位于两个工作区的节点被识别为交叠区", () => {
  const g = emptyGraph()
  addNode(g, node("a"))
  addNode(g, node("b"))
  addWorkspace(g, workspace("w1"))
  addWorkspace(g, workspace("w2"))

  joinWorkspace(g, "w1", "a", NOW)
  joinWorkspace(g, "w2", "a", NOW)
  joinWorkspace(g, "w1", "b", NOW)

  assert.deepEqual(overlapNodes(g), ["a"])
  const a = g.members.filter((m) => m.nodeId === "a")
  assert.ok(a.every((m) => m.overlap === true))

  // 移除一侧后交叠标记应回退
  leaveWorkspace(g, "w2", "a")
  assert.deepEqual(overlapNodes(g), [])
  const b = g.members.filter((m) => m.nodeId === "a")
  assert.ok(b.every((m) => m.overlap === false))
})

test("节点尺寸随 token 对数增长且有上界", () => {
  assert.ok(nodeRadius(0) < nodeRadius(1000))
  assert.ok(nodeRadius(1000) <= nodeRadius(200_000))
  assert.equal(nodeRadius(10_000_000), 64)
  assert.ok(nodeRadius(-5) >= 8)
})
