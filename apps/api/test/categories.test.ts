import { test, expect } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { newNode } from "../src/mapper.ts"
import { parseMetadata } from "../src/metadata.ts"
import { GraphStore } from "../src/store.ts"

test("旧类别读入后成为多类别，保存时保持首类别映射", () => {
  const dir = mkdtempSync(join(tmpdir(), "nodex-categories-"))
  const file = join(dir, "graph.json")
  try {
    const { categories: _categories, ...legacy } = newNode({ id: "legacy", title: "旧节点", category: "前端" })
    writeFileSync(file, JSON.stringify({ nodes: [legacy], links: [], workspaces: [], members: [] }))
    const store = new GraphStore(file)
    expect(store.node("legacy")).toMatchObject({ category: "前端", categories: ["前端"] })
    expect(JSON.parse(readFileSync(file, "utf8")).nodes[0].categories).toBeUndefined()

    expect(store.patchNode("legacy", { categories: [" API ", "前端", "API", ""] })).toMatchObject({ category: "API", categories: ["API", "前端"] })
    expect(new GraphStore(file).node("legacy")?.categories).toEqual(["API", "前端"])
    expect(store.patchNode("legacy", { category: "测试" })).toMatchObject({ category: "测试", categories: ["测试"] })
    expect(store.patchNode("legacy", { categories: [] })).toMatchObject({ category: "", categories: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("元数据兼容单类别回复并读取多类别回复", () => {
  expect(parseMetadata('{"title":"接口","category":"API","summary":"设计"}')?.categories).toEqual(["API"])
  expect(parseMetadata('{"title":"接口","categories":["API","前端"," API "],"summary":"设计"}')?.categories).toEqual(["API", "前端"])
})

test("图谱持久化带 schemaVersion，旧文件载入时迁移", () => {
  const dir = mkdtempSync(join(tmpdir(), "nodex-schema-"))
  const file = join(dir, "graph.json")
  try {
    const { categories: _categories, ...legacy } = newNode({ id: "n1", title: "旧节点", category: "前端" })
    writeFileSync(file, JSON.stringify({ nodes: [legacy], links: [], workspaces: [], members: [] }))
    const store = new GraphStore(file)
    expect(store.snapshot().schemaVersion).toBe(1)
    store.patchNode("n1", { title: "新节点" })
    expect(JSON.parse(readFileSync(file, "utf8")).schemaVersion).toBe(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
