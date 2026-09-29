import assert from "node:assert/strict"
import test from "node:test"
import {
  anchorPanel,
  boundsIntersect,
  computeFit,
  computeGhosts,
  distanceToSegment,
  hitTestLink,
  linkMidpoint,
  nodeRadius,
  nodeHasCategory,
  pointInPolygon,
  relax,
  seedLayout,
  standardizeLayout,
  isOnPage,
  toScreen,
  toWorld,
  unionRect,
  visibleNodeIds,
  WORKSPACE_MIN_SIZE,
  workspaceBounds,
  zoomedCamera,
} from "../public/graph-layout.js"

// 复现演示图谱：前端 2 节点、后端 2 节点、公共规范 1 节点，
// 其中「API 契约对齐」同时属于前端与公共规范（交叠区）。
function demoGraph() {
  const nodes = [
    { id: "fa", tokenCount: 0 }, { id: "fb", tokenCount: 0 },
    { id: "ba", tokenCount: 0 }, { id: "bb", tokenCount: 0 },
    { id: "ov", tokenCount: 0 }, { id: "spec", tokenCount: 0 },
    { id: "out", tokenCount: 0 },
  ]
  const members = [
    { workspaceId: "wsa", nodeId: "fa" }, { workspaceId: "wsa", nodeId: "fb" },
    { workspaceId: "wsa", nodeId: "ov" },
    { workspaceId: "wsb", nodeId: "ba" }, { workspaceId: "wsb", nodeId: "bb" },
    { workspaceId: "wsc", nodeId: "ov" }, { workspaceId: "wsc", nodeId: "spec" },
  ]
  return { nodes, members }
}

function build() {
  const { nodes, members } = demoGraph()
  const positions = new Map()
  const anchors = new Map()
  const pinned = new Set()
  const radiusOf = (id) => nodeRadius(nodes.find((n) => n.id === id)?.tokenCount ?? 0)
  seedLayout({ nodes, members, positions, anchors })
  relax({ nodes, positions, anchors, pinned, radiusOf })
  return { nodes, members, positions, anchors, pinned, radiusOf }
}

test("布局不偏向单一角落：各方向都有节点", () => {
  const { nodes, positions } = build()
  const pts = nodes.map((n) => positions.get(n.id))
  // 以质心为原点，检查四个象限是否都有节点，防止整体挤到一角
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  const quads = new Set(
    pts.map((p) => `${p.x >= cx ? "R" : "L"}${p.y >= cy ? "D" : "U"}`),
  )
  assert.ok(quads.size >= 3, `节点应分布在多个象限，实际: ${[...quads]}`)

  const spanX = Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x))
  const spanY = Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y))
  assert.ok(spanX > 100 && spanY > 100, `布局应有合理延展，实际 ${spanX}x${spanY}`)
})

test("松弛后节点互不重叠", () => {
  const { nodes, positions, radiusOf } = build()
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = positions.get(nodes[i].id)
      const b = positions.get(nodes[j].id)
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const min = radiusOf(nodes[i].id) + radiusOf(nodes[j].id)
      assert.ok(d >= min - 1e-6, `节点 ${nodes[i].id} 与 ${nodes[j].id} 重叠: ${d} < ${min}`)
    }
  }
})

test("锁定节点不被松弛移动", () => {
  const { nodes, positions, anchors, radiusOf } = build()
  const locked = { ...positions.get("fa") }
  const pinned = new Set(["fa"])
  // 人为把另一节点压到 fa 上，制造斥力
  positions.set("fb", { x: locked.x + 1, y: locked.y })
  relax({ nodes, positions, anchors, pinned, radiusOf, iterations: 200 })
  assert.deepEqual(positions.get("fa"), locked)
})

test("缩放和平移后在右键落点创建的节点保持固定", () => {
  const camera = { x: 185, y: -74, zoom: 1.6 }
  const viewport = { w: 1200, h: 800 }
  const click = { x: 892, y: 570 }
  const placed = toWorld(camera, viewport, click.x, click.y)
  const nodes = [{ id: "placed", tokenCount: 0 }, { id: "other", tokenCount: 0 }]
  const positions = new Map([["placed", { ...placed }]])
  const anchors = new Map([["placed", { ...placed }]])
  seedLayout({ nodes, members: [], positions, anchors })
  relax({ nodes, positions, anchors, pinned: new Set(["placed"]), radiusOf: () => 16 })
  assert.deepEqual(positions.get("placed"), placed)
  assert.deepEqual(toScreen(camera, viewport, placed.x, placed.y), click)
})

test("圈选只包含闭合线内及边界上的节点中心", () => {
  const concave = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 100 }, { x: 0, y: 100 }]
  assert.equal(pointInPolygon({ x: 15, y: 80 }, concave), true)
  assert.equal(pointInPolygon({ x: 60, y: 60 }, concave), false)
  assert.equal(pointInPolygon({ x: 30, y: 60 }, concave), true)
  assert.equal(pointInPolygon({ x: 130, y: 10 }, concave), false)
  assert.equal(pointInPolygon({ x: 15, y: 15 }, concave.slice(0, 2)), false)
})

test("圈选与画布缩放、平移后节点屏幕坐标保持一致", () => {
  const camera = { x: 180, y: -40, zoom: 1.7 }
  const viewport = { w: 960, h: 720 }
  const inside = toScreen(camera, viewport, 120, 50)
  const outside = toScreen(camera, viewport, 400, 50)
  const polygon = [{ x: inside.x - 20, y: inside.y - 20 }, { x: inside.x + 20, y: inside.y - 20 }, { x: inside.x + 20, y: inside.y + 20 }, { x: inside.x - 20, y: inside.y + 20 }]
  assert.equal(pointInPolygon(inside, polygon), true)
  assert.equal(pointInPolygon(outside, polygon), false)
})

test("交叠工作区的包围盒真实相交", () => {
  const { nodes, members, positions } = build()
  const wsa = workspaceBounds({ members, positions, workspaceId: "wsa" })
  const wsc = workspaceBounds({ members, positions, workspaceId: "wsc" })
  assert.ok(boundsIntersect(wsa, wsc), "前端与公共规范的包围盒应交叠")
})

test("不相干工作区的包围盒不相交", () => {
  const { members, positions } = build()
  const wsb = workspaceBounds({ members, positions, workspaceId: "wsb" })
  const wsc = workspaceBounds({ members, positions, workspaceId: "wsc" })
  assert.ok(!boundsIntersect(wsb, wsc), "后端与公共规范不应交叠")
})

test("页面过滤：节点可属于多个页面", () => {
  const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }]
  const members = [
    { workspaceId: "p1", nodeId: "a" },
    { workspaceId: "p1", nodeId: "b" },
    { workspaceId: "p2", nodeId: "b" }, // b 同时属于两个页面
  ]
  assert.equal(isOnPage(members, "b", "p1"), true)
  assert.equal(isOnPage(members, "b", "p2"), true)
  assert.equal(isOnPage(members, "c", "p1"), false)
  assert.equal(isOnPage(members, "c", null), true, "null 表示全部页面")
  assert.deepEqual(visibleNodeIds(nodes, members, "p1"), ["a", "b"])
  assert.deepEqual(visibleNodeIds(nodes, members, null), ["a", "b", "c"])
})

test("类别标签按多类别归属筛选，不改变页面成员关系", () => {
  const nodes = [
    { id: "a", categories: ["生成模型", "文献调研"] },
    { id: "b", categories: ["文献调研"] },
    { id: "c", category: "旧类别" },
    { id: "d", categories: [] },
  ]
  assert.deepEqual(nodes.filter((node) => nodeHasCategory(node, "文献调研")).map((node) => node.id), ["a", "b"])
  assert.equal(nodeHasCategory(nodes[0], "生成模型"), true)
  assert.equal(nodeHasCategory(nodes[2], "旧类别"), true)
  assert.equal(nodeHasCategory(nodes[3], "文献调研"), false)
  const members = nodes.filter((node) => nodeHasCategory(node, "文献调研")).map((node) => ({ workspaceId: "category-view", nodeId: node.id }))
  const ghosts = computeGhosts({ links: [{ id: "l", from: "a", to: "c" }], members,
    positions: new Map([["a", { x: 0, y: 0 }], ["c", { x: 100, y: 0 }]]), activeWs: "category-view", radiusOf: () => 20 })
  assert.deepEqual(ghosts.map((ghost) => ghost.id), ["c"])
})

test("跨页连线生成幽灵节点，本页内连线不生成", () => {
  const members = [
    { workspaceId: "p1", nodeId: "a" },
    { workspaceId: "p1", nodeId: "b" },
    { workspaceId: "p2", nodeId: "c" },
  ]
  const positions = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 100, y: 0 }],
    ["c", { x: 500, y: 0 }],
  ])
  const links = [
    { id: "L1", from: "a", to: "b" }, // 本页内
    { id: "L2", from: "a", to: "c" }, // 跨页
  ]
  const ghosts = computeGhosts({
    links,
    members,
    positions,
    activeWs: "p1",
    radiusOf: () => 20,
    gap: 48,
  })
  assert.equal(ghosts.length, 1, "只有跨页连线产生一个幽灵")
  assert.equal(ghosts[0].id, "c")
  assert.equal(ghosts[0].hostId, "a")
  assert.equal(ghosts[0].linkId, "L2")
  // 幽灵在宿主外环、且朝向真实节点（x 正向）
  assert.ok(ghosts[0].x > 0, "幽灵应朝 c 的方向")
  assert.equal(Math.round(ghosts[0].y), 0)
})

test("全部页面视图不产生幽灵", () => {
  const ghosts = computeGhosts({
    links: [{ id: "L", from: "a", to: "b" }],
    members: [],
    positions: new Map([["a", { x: 0, y: 0 }], ["b", { x: 10, y: 0 }]]),
    activeWs: null,
    radiusOf: () => 20,
  })
  assert.deepEqual(ghosts, [])
})

test("unionRect 返回两矩形的最小外接矩形", () => {
  assert.deepEqual(unionRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: -5, w: 10, h: 10 }), {
    x: 0,
    y: -5,
    w: 15,
    h: 15,
  })
})

test("空工作区靠 origin 也能画出可见画布框", () => {
  const members = []
  const positions = new Map()
  const box = workspaceBounds({
    members,
    positions,
    workspaceId: "empty",
    origin: { x: 500, y: 200 },
  })
  assert.deepEqual(box, { x: 500, y: 200, w: WORKSPACE_MIN_SIZE.w, h: WORKSPACE_MIN_SIZE.h })
})

test("空工作区没有 origin 时才返回 null", () => {
  assert.equal(workspaceBounds({ members: [], positions: new Map(), workspaceId: "x" }), null)
})

test("有成员时以成员包围盒为准，忽略 origin", () => {
  const members = [{ workspaceId: "w", nodeId: "a" }]
  const positions = new Map([["a", { x: 100, y: 100 }]])
  const box = workspaceBounds({
    members,
    positions,
    workspaceId: "w",
    origin: { x: -9999, y: -9999 },
  })
  assert.equal(box.x, 100 - 58)
  assert.equal(box.y, 100 - 58)
})

test("screen/world 互为逆变换", () => {
  const camera = { x: 120, y: -80, zoom: 1.7 }
  const vp = { w: 1280, h: 720 }
  const world = { x: 340, y: 55 }
  const s = toScreen(camera, vp, world.x, world.y)
  const back = toWorld(camera, vp, s.x, s.y)
  assert.ok(Math.abs(back.x - world.x) < 1e-9)
  assert.ok(Math.abs(back.y - world.y) < 1e-9)
})

test("以光标为锚缩放时该点世界坐标不变", () => {
  const camera = { x: 0, y: 0, zoom: 1 }
  const vp = { w: 1000, h: 800 }
  const sx = 700, sy = 250
  const before = toWorld(camera, vp, sx, sy)
  const zoomed = zoomedCamera(camera, vp, sx, sy, 1.5)
  const after = toWorld(zoomed, vp, sx, sy)
  assert.ok(Math.abs(after.x - before.x) < 1e-9, "缩放锚点 x 漂移")
  assert.ok(Math.abs(after.y - before.y) < 1e-9, "缩放锚点 y 漂移")
})

test("缩放受上下限约束", () => {
  const vp = { w: 800, h: 600 }
  let cam = { x: 0, y: 0, zoom: 1 }
  for (let i = 0; i < 80; i++) cam = zoomedCamera(cam, vp, 0, 0, 1.5)
  assert.ok(cam.zoom <= 4 + 1e-9, `上限失效: ${cam.zoom}`)
  for (let i = 0; i < 200; i++) cam = zoomedCamera(cam, vp, 0, 0, 1 / 1.5)
  assert.ok(cam.zoom >= 0.15 - 1e-9, `下限失效: ${cam.zoom}`)
})

test("适应视图后所有节点落在视口内", () => {
  const { nodes, positions, radiusOf } = build()
  const vp = { w: 1280, h: 720 }
  const camera = computeFit({ nodes, positions, radiusOf, viewport: vp })
  for (const n of nodes) {
    const p = positions.get(n.id)
    const r = radiusOf(n.id)
    const s = toScreen(camera, vp, p.x, p.y)
    assert.ok(s.x >= -1 && s.x <= vp.w + 1, `${n.id} 超出水平视口: ${s.x}`)
    assert.ok(s.y >= -1 && s.y <= vp.h + 1, `${n.id} 超出垂直视口: ${s.y}`)
  }
})

test("详情面板锚定在节点右侧并随节点移动", () => {
  const vp = { w: 1400, h: 900 }
  const panel = { w: 320, h: 260 }
  const leftPos = anchorPanel({ nodeScreen: { x: 300, y: 400 }, nodeRadiusPx: 30, panel, viewport: vp })
  const rightPos = anchorPanel({ nodeScreen: { x: 600, y: 400 }, nodeRadiusPx: 30, panel, viewport: vp })
  assert.ok(leftPos.left < rightPos.left, "面板应随节点水平移动")
  assert.ok(leftPos.left > 300, "默认应位于节点右侧")
})

test("靠近右边界时详情面板翻转到左侧且不越界", () => {
  const vp = { w: 1000, h: 700 }
  const panel = { w: 320, h: 260 }
  const pos = anchorPanel({ nodeScreen: { x: 980, y: 350 }, nodeRadiusPx: 30, panel, viewport: vp })
  assert.ok(pos.left >= 12, "面板不应越过左边界")
  assert.ok(pos.left + panel.w <= vp.w - 12 + 1e-9, "面板不应越过右边界")
  assert.ok(pos.left < 980, "应翻转到节点左侧")
})

test("详情面板在垂直方向被夹紧在视口内", () => {
  const vp = { w: 1000, h: 700 }
  const panel = { w: 320, h: 260 }
  const top = anchorPanel({ nodeScreen: { x: 100, y: 5 }, nodeRadiusPx: 30, panel, viewport: vp })
  const bottom = anchorPanel({ nodeScreen: { x: 100, y: 695 }, nodeRadiusPx: 30, panel, viewport: vp })
  assert.ok(top.top >= 12)
  assert.ok(bottom.top + panel.h <= vp.h - 12 + 1e-9)
})

test("节点尺寸随 token 对数增长且有上界", () => {
  assert.ok(nodeRadius(0) < nodeRadius(1000))
  assert.ok(nodeRadius(1000) <= nodeRadius(200000))
  assert.equal(nodeRadius(10000000), 52)
})

// ---------------- 连线命中测试 ----------------

test("点到线段距离：垂足在段内、段外与退化情形", () => {
  assert.equal(distanceToSegment(0, 5, 0, 0, 10, 0), 5)
  // 垂足落在延长线外，应取端点距离
  assert.equal(distanceToSegment(-5, 0, 0, 0, 10, 0), 5)
  assert.equal(distanceToSegment(15, 0, 0, 0, 10, 0), 5)
  // 退化线段（两端重合）
  assert.equal(distanceToSegment(3, 4, 0, 0, 0, 0), 5)
})

test("命中连线：靠近中点的点击可选中该连线", () => {
  const positions = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 200, y: 0 }],
    ["c", { x: 0, y: 300 }],
    ["d", { x: 200, y: 300 }],
  ])
  const links = [
    { id: "l1", from: "a", to: "b" },
    { id: "l2", from: "c", to: "d" },
  ]
  const radiusOf = () => 20
  const hit = hitTestLink({ links, positions, world: { x: 100, y: 4 }, tolerance: 10, radiusOf })
  assert.equal(hit?.id, "l1")
})

test("命中连线：距离超出容差不选中", () => {
  const positions = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 200, y: 0 }],
  ])
  const links = [{ id: "l1", from: "a", to: "b" }]
  const hit = hitTestLink({ links, positions, world: { x: 100, y: 40 }, tolerance: 10, radiusOf: () => 20 })
  assert.equal(hit, null)
})

test("命中连线：落在节点圆内的点击不算连线，避免与节点点击冲突", () => {
  const positions = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 200, y: 0 }],
  ])
  const links = [{ id: "l1", from: "a", to: "b" }]
  const hit = hitTestLink({ links, positions, world: { x: 10, y: 0 }, tolerance: 30, radiusOf: () => 20 })
  assert.equal(hit, null, "节点圆内的点击应由节点处理")
})

test("命中连线：多条候选时返回最近的一条", () => {
  const positions = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 200, y: 0 }],
    ["c", { x: 0, y: 10 }],
    ["d", { x: 200, y: 10 }],
  ])
  const links = [
    { id: "far", from: "c", to: "d" },
    { id: "near", from: "a", to: "b" },
  ]
  const hit = hitTestLink({ links, positions, world: { x: 100, y: 2 }, tolerance: 30, radiusOf: () => 5 })
  assert.equal(hit?.id, "near")
})

test("连线中点用于定位面板", () => {
  const positions = new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 100, y: 50 }],
  ])
  assert.deepEqual(linkMidpoint(positions, { from: "a", to: "b" }), { x: 50, y: 25 })
  assert.equal(linkMidpoint(positions, { from: "a", to: "missing" }), null)
})

test("标准化布局：按连接分层且不重叠", () => {
  const nodes = ["a", "b", "c", "d", "e"].map((id) => ({ id, tokenCount: 0 }))
  const links = [
    { id: "l1", from: "a", to: "b" },
    { id: "l2", from: "a", to: "c" },
    { id: "l3", from: "b", to: "d" },
    { id: "l4", from: "c", to: "e" },
  ]
  const positions = new Map(nodes.map((n, i) => [n.id, { x: (i % 2) * 300, y: i * 400 }]))
  const radiusOf = () => 16
  standardizeLayout({ nodes, links, positions, radiusOf })
  // 分层：a 在最左，b/c 其次，d/e 最右
  assert.ok(positions.get("a").x < positions.get("b").x)
  assert.ok(positions.get("b").x < positions.get("d").x)
  assert.ok(positions.get("a").x < positions.get("c").x)
  assert.ok(positions.get("c").x < positions.get("e").x)
  // 互不重叠
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = positions.get(nodes[i].id)
      const b = positions.get(nodes[j].id)
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 32 - 1e-6, `${nodes[i].id} 与 ${nodes[j].id} 重叠`)
    }
  }
})

test("标准化布局：多个连通分量互不重叠", () => {
  const nodes = ["a", "b", "c", "d"].map((id) => ({ id, tokenCount: 0 }))
  const links = [
    { id: "l1", from: "a", to: "b" },
    { id: "l2", from: "c", to: "d" },
  ]
  const positions = new Map(nodes.map((n, i) => [n.id, { x: i * 10, y: 0 }]))
  standardizeLayout({ nodes, links, positions, radiusOf: () => 16 })
  const a = positions.get("a")
  const c = positions.get("c")
  assert.ok(Math.hypot(a.x - c.x, a.y - c.y) > 200, "两个连通分量应拉开距离")
})
