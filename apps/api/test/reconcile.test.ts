import { test, expect } from "bun:test"
import { planReconcile } from "../src/reconcile.ts"

test("reconcile 标记会话已消失的节点，并在带 parentId 时补齐 fork 血缘", () => {
  const nodes = [
    { id: "n_parent", opencodeSessionId: "ses_parent" },
    { id: "n_child", opencodeSessionId: "ses_child" },
    { id: "n_orphan", opencodeSessionId: "ses_gone" },
  ]
  const sessions = [
    { id: "ses_parent" },
    { id: "ses_child", parentId: "ses_parent" },
  ]
  const plan = planReconcile(nodes, sessions)
  expect(plan.okNodeIds.sort()).toEqual(["n_child", "n_parent"])
  expect(plan.missingNodeIds).toEqual(["n_orphan"])
  expect(plan.forkLinks).toEqual([{ fromNodeId: "n_parent", toNodeId: "n_child" }])
})

test("reconcile 忽略自环与无 parentId 的会话，未知父会话不产生链接", () => {
  const nodes = [
    { id: "n1", opencodeSessionId: "ses_1" },
    { id: "n2", opencodeSessionId: "ses_2" },
  ]
  const plan = planReconcile(nodes, [
    { id: "ses_1", parentId: "ses_1" },
    { id: "ses_2", parentId: "ses_unknown" },
    { id: "ses_3" },
  ])
  expect(plan.forkLinks).toEqual([])
  expect(plan.missingNodeIds).toEqual([])
  expect(plan.okNodeIds.sort()).toEqual(["n1", "n2"])
})
