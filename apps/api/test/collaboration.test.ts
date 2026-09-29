import { test, expect } from "bun:test"
import { collaborationLayout, collaborationDependencies, shouldAutoRenameChild, isPlaceholderTitle } from "../src/collaboration.ts"
import type { CollaborationInstance } from "../src/store.ts"

function dependencies(kind: CollaborationInstance["kind"], config: CollaborationInstance["config"]) {
  const shape = collaborationLayout(kind, config)
  return collaborationDependencies({ ...shape, id: "test", name: "test", kind, ownedNodeIds: [], createdAt: "", updatedAt: "" })
}

test("three ministries supports variable layers without dangling links", () => {
  const shape = collaborationLayout("three-ministries", { layers: [2, 3, 1] })
  expect(shape.slots).toHaveLength(7)
  expect(shape.slots[0]).toMatchObject({ key: "emperor", label: "皇帝" })
  expect(shape.mainKey).toBe("emperor")
  expect(shape.links.filter((link) => link.from === "emperor").map((link) => link.to)).toEqual(["layer1_1", "layer1_2"])
  expect(shape.links.every((link) => shape.slots.some((slot) => slot.key === link.from) && shape.slots.some((slot) => slot.key === link.to))).toBe(true)
  expect(() => collaborationLayout("three-ministries", { layers: [1] })).toThrow()
  expect(() => collaborationLayout("three-ministries", { layers: [2, 0] })).toThrow()
})

test("brainstorm adds an agent per requested child and one center", () => {
  const shape = collaborationLayout("brainstorm", { agents: 4 })
  expect(shape.slots).toHaveLength(5)
  expect(shape.links).toHaveLength(4)
  expect(shape.mainKey).toBe("center")
  expect(() => collaborationLayout("brainstorm", { agents: 50 })).toThrow()
})

test("debate supports variable sides and speakers", () => {
  const shape = collaborationLayout("debate", { sides: 3, perSide: 2 })
  expect(shape.slots).toHaveLength(8)
  expect(shape.links).toHaveLength(9)
  expect(shape.mainKey).toBe("moderator")
  expect(() => collaborationLayout("debate", { sides: 1, perSide: 2 })).toThrow()
})

test("brainstorm workers run independently, ministries reduce bottom-up, debate waits for each speaker chain", () => {
  const brainstorm = dependencies("brainstorm", { agents: 3 })
  expect([...brainstorm.values()]).toEqual([[], [], []])

  const ministries = dependencies("three-ministries", { layers: [2, 2] })
  expect(ministries.get("layer2_1")).toEqual([])
  expect(ministries.get("layer2_2")).toEqual([])
  expect(ministries.get("layer1_2")).toEqual(["layer2_2"])
  expect(ministries.get("layer1_1")).toEqual(["layer2_1", "layer1_2"])

  const debate = dependencies("debate", { sides: 2, perSide: 2 })
  expect(debate.get("side1_1")).toEqual([])
  expect(debate.get("side1_2")).toEqual(["side1_1"])
  expect(debate.get("judge")).toEqual(["side1_2", "side2_2"])
})

test("child auto-rename covers both owned and bound placeholder nodes", () => {
  // 协作新建的节点：仍是角色名才改
  expect(shouldAutoRenameChild("评审", "评审", true)).toBe(true)
  expect(shouldAutoRenameChild("我改过的名字", "评审", true)).toBe(false)
  // 用户绑定的已有节点：仍是占位标题才改，不覆盖已有命名
  expect(shouldAutoRenameChild("未命名节点", "第1方 1辩", false)).toBe(true)
  expect(shouldAutoRenameChild("", "第1方 1辩", false)).toBe(true)
  expect(shouldAutoRenameChild("语音合成调研", "第1方 1辩", false)).toBe(false)
  expect(isPlaceholderTitle("未命名节点")).toBe(true)
  expect(isPlaceholderTitle("语音合成调研")).toBe(false)
})
