import { test, expect } from "bun:test"
import { selectedMessageRange } from "../public/message-range.js"

const ids = ["first", "second", "third", "latest"]

test("起点延伸到最新，终点涵盖最早，双端点限定区间", () => {
  expect(selectedMessageRange(ids, "second", null)).toEqual(["second", "third", "latest"])
  expect(selectedMessageRange(ids, null, "third")).toEqual(["first", "second", "third"])
  expect(selectedMessageRange(ids, "second", "third")).toEqual(["second", "third"])
  expect(selectedMessageRange(ids, "third", "second")).toEqual(["second", "third"])
  expect(selectedMessageRange([...ids, "new"], "second", null)).toEqual(["second", "third", "latest", "new"])
})

test("边界包含端点且已失效或未选择的端点不会选中消息", () => {
  expect(selectedMessageRange(ids, "second", "second")).toEqual(["second"])
  expect(selectedMessageRange(ids, null, null)).toEqual([])
  expect(selectedMessageRange(ids, "missing", null)).toEqual([])
  expect(selectedMessageRange([], "first", null)).toEqual([])
})
