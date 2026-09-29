// NodeX 画布纯几何模块（无 DOM 依赖，可单测）。
//
// 坐标约定：
//   world   节点的逻辑坐标，与屏幕尺寸/DPR 无关。
//   camera  { x, y, zoom }，其中 (x, y) 是视口中心对应的世界坐标。
//   screen  CSS 像素坐标，左上角为原点。

export const ZOOM_LIMITS = { min: 0.15, max: 4 }

export const RADIUS = { min: 16, max: 52 }

/** 节点半径：token 数取对数，避免长会话撑爆画布。 */
export function nodeRadius(tokenCount, { min = RADIUS.min, max = RADIUS.max } = {}) {
  const t = Math.log1p(Math.max(0, tokenCount)) / Math.log1p(200000)
  return min + (max - min) * Math.min(1, t)
}

export function toScreen(camera, viewport, wx, wy) {
  return {
    x: (wx - camera.x) * camera.zoom + viewport.w / 2,
    y: (wy - camera.y) * camera.zoom + viewport.h / 2,
  }
}

export function toWorld(camera, viewport, sx, sy) {
  return {
    x: (sx - viewport.w / 2) / camera.zoom + camera.x,
    y: (sy - viewport.h / 2) / camera.zoom + camera.y,
  }
}

export function pointInPolygon(point, polygon) {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i]
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x)
    if (Math.abs(cross) < 1e-7 && point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x) && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y)) return true
    if ((a.y > point.y) !== (b.y > point.y) && point.x < a.x + (b.x - a.x) * (point.y - a.y) / (b.y - a.y)) inside = !inside
  }
  return inside
}

/**
 * 以屏幕上某点为锚缩放。
 * 保证锚点下方的世界坐标在缩放前后不变（滚轮缩放不跑偏）。
 */
export function zoomedCamera(camera, viewport, sx, sy, factor, limits = ZOOM_LIMITS) {
  const before = toWorld(camera, viewport, sx, sy)
  const zoom = Math.max(limits.min, Math.min(limits.max, camera.zoom * factor))
  const x = before.x - (sx - viewport.w / 2) / zoom
  const y = before.y - (sy - viewport.h / 2) / zoom
  return { x, y, zoom }
}

/**
 * 为尚无位置的节点播种坐标。
 * 工作区环形排布成簇，节点围绕簇心，圈外节点在外环。
 * 返回 workspaceId -> 簇心 映射。
 */
export function seedLayout({ nodes, members, positions, anchors }) {
  const groups = new Map()
  for (const m of members) {
    if (!groups.has(m.workspaceId)) groups.set(m.workspaceId, [])
    groups.get(m.workspaceId).push(m.nodeId)
  }

  const wsIds = [...groups.keys()]
  const counts = wsIds.map((id) => new Set(groups.get(id)).size)
  const maxCount = Math.max(1, ...counts)
  // 用最大簇半径决定网格间距，让各页面既紧凑又不重叠。
  const clusterRadius = Math.max(90, 34 * Math.sqrt(maxCount) + 40)
  const cell = clusterRadius * 2 + 120
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, wsIds.length))))
  const rows = Math.ceil(wsIds.length / cols)
  const cluster = new Map()

  wsIds.forEach((wsId, wi) => {
    const col = wi % cols
    const row = Math.floor(wi / cols)
    const cx = (col - (cols - 1) / 2) * cell
    const cy = (row - (rows - 1) / 2) * cell
    cluster.set(wsId, { x: cx, y: cy })

    const ids = [...new Set(groups.get(wsId))]
    const ring = Math.max(58, 30 * Math.sqrt(ids.length) + 18)
    ids.forEach((id, i) => {
      const a = (i / Math.max(1, ids.length)) * Math.PI * 2 - Math.PI / 2
      const p = ids.length === 1 ? { x: cx, y: cy } : { x: cx + Math.cos(a) * ring, y: cy + Math.sin(a) * ring }
      if (!positions.has(id)) {
        positions.set(id, { ...p })
        anchors.set(id, { ...p })
      }
    })
  })

  const inWs = new Set(members.map((m) => m.nodeId))
  const outside = nodes.filter((n) => !inWs.has(n.id))
  const outCols = Math.max(1, Math.ceil(Math.sqrt(outside.length)))
  const outStartX = (cols * cell) / 2 + cell
  outside.forEach((n, i) => {
    if (positions.has(n.id)) return
    const col = i % outCols
    const row = Math.floor(i / outCols)
    const p = {
      x: outStartX + (col - (outCols - 1) / 2) * cell,
      y: (row - (Math.ceil(outside.length / outCols) - 1) / 2) * cell,
    }
    positions.set(n.id, { ...p })
    anchors.set(n.id, { ...p })
  })

  return cluster
}

/**
 * 标准化布局：按连接关系分层，层内用重心排序减少连线交叉，
 * 再交给 relax 消除重叠。保持节点连接不变，只重排位置。
 */
export function standardizeLayout({ nodes, links, positions, radiusOf, gap = 70 }) {
  const ids = nodes.map((n) => n.id).filter((id) => positions.has(id))
  const idSet = new Set(ids)
  const adjacency = new Map(ids.map((id) => [id, []]))
  const successors = new Map(ids.map((id) => [id, []]))
  const incoming = new Map(ids.map((id) => [id, []]))
  for (const link of links) {
    if (!idSet.has(link.from) || !idSet.has(link.to) || link.from === link.to) continue
    adjacency.get(link.from).push(link.to)
    adjacency.get(link.to).push(link.from)
    successors.get(link.from).push(link.to)
    incoming.get(link.to).push(link.from)
  }

  const seen = new Set()
  const components = []
  for (const id of ids) {
    if (seen.has(id)) continue
    const stack = [id]
    const comp = []
    seen.add(id)
    while (stack.length) {
      const cur = stack.pop()
      comp.push(cur)
      for (const next of adjacency.get(cur)) {
        if (!seen.has(next)) {
          seen.add(next)
          stack.push(next)
        }
      }
    }
    components.push(comp)
  }

  const layoutComponent = (comp, originX, originY) => {
    const roots = comp.filter((id) => incoming.get(id).length === 0)
    const seeds = roots.length
      ? roots
      : [comp.reduce((best, id) => (adjacency.get(id).length > adjacency.get(best).length ? id : best), comp[0])]
    const layer = new Map()
    const queue = []
    for (const root of seeds) {
      if (!layer.has(root)) {
        layer.set(root, 0)
        queue.push(root)
      }
    }
    let head = 0
    while (head < queue.length) {
      const cur = queue[head++]
      const d = layer.get(cur)
      for (const next of adjacency.get(cur)) {
        if (!layer.has(next)) {
          layer.set(next, d + 1)
          queue.push(next)
        }
      }
    }
    for (const id of comp) if (!layer.has(id)) layer.set(id, 0)

    const layers = new Map()
    for (const id of comp) {
      const d = layer.get(id)
      if (!layers.has(d)) layers.set(d, [])
      layers.get(d).push(id)
    }
    const depth = Math.max(...layers.keys())
    const order = new Map()
    for (const list of layers.values()) list.forEach((id, i) => order.set(id, i))
    const barycenter = (id, neighborsOf) => {
      const ns = neighborsOf(id).filter((n) => order.has(n))
      if (!ns.length) return order.get(id) ?? 0
      return ns.reduce((sum, n) => sum + order.get(n), 0) / ns.length
    }
    const sortLayer = (d, neighborsOf) => {
      const list = layers.get(d)
      if (!list || list.length < 2) return
      list.sort((a, b) => {
        const diff = barycenter(a, neighborsOf) - barycenter(b, neighborsOf)
        return diff || (order.get(a) - order.get(b))
      })
      list.forEach((id, i) => order.set(id, i))
    }
    for (let pass = 0; pass < 6; pass++) {
      for (let d = 1; d <= depth; d++) sortLayer(d, (id) => incoming.get(id))
      for (let d = depth - 1; d >= 0; d--) sortLayer(d, (id) => successors.get(id))
    }

    const hGap = 155
    const vGap = 120
    let maxCount = 1
    for (const list of layers.values()) maxCount = Math.max(maxCount, list.length)
    for (const [d, list] of layers) {
      list.forEach((id, i) => {
        positions.set(id, {
          x: originX + d * hGap,
          y: originY + (i - (list.length - 1) / 2) * vGap,
        })
      })
    }
    return { width: depth * hGap, height: maxCount * vGap }
  }

  const centroid = ids.reduce(
    (acc, id) => {
      const p = positions.get(id)
      return { x: acc.x + p.x / ids.length, y: acc.y + p.y / ids.length }
    },
    { x: 0, y: 0 },
  )
  let offsetX = centroid.x - ((components.length - 1) * 480) / 2
  for (const comp of components) {
    const size = layoutComponent(comp, offsetX, centroid.y)
    offsetX += Math.max(480, size.width + 240)
  }

  const anchors = new Map(ids.map((id) => [id, { ...positions.get(id) }]))
  relax({ nodes, positions, anchors, pinned: new Set(), radiusOf, iterations: 220, gap })
}

/**
 * 斥力松弛：消除节点重叠，同时用弱弹簧约束在锚点附近，
 * 避免节点因斥力无限漂移。pinned 中的节点保持不动。
 */
export function relax({ nodes, positions, anchors, pinned, radiusOf, iterations = 160, gap = 36 }) {
  const ids = nodes.map((n) => n.id).filter((id) => positions.has(id))

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < ids.length; i++) {
      const a = positions.get(ids[i])
      for (let j = i + 1; j < ids.length; j++) {
        const b = positions.get(ids[j])
        let dx = b.x - a.x
        let dy = b.y - a.y
        let d = Math.hypot(dx, dy)
        if (d < 1e-3) {
          // 完全重合时给出确定性的分离方向，避免随机导致布局抖动
          dx = i % 2 ? 1 : -1
          dy = j % 2 ? 1 : -1
          d = Math.SQRT2
        }
        const min = radiusOf(ids[i]) + radiusOf(ids[j]) + gap
        if (d < min) {
          const push = (min - d) / 2
          const ux = dx / d
          const uy = dy / d
          if (!pinned.has(ids[i])) { a.x -= ux * push; a.y -= uy * push }
          if (!pinned.has(ids[j])) { b.x += ux * push; b.y += uy * push }
        }
      }
    }

    for (const id of ids) {
      if (pinned.has(id)) continue
      const p = positions.get(id)
      const anc = anchors.get(id)
      if (!anc) continue
      p.x += (anc.x - p.x) * 0.06
      p.y += (anc.y - p.y) * 0.06
    }
  }
}

/** 计算使所有节点可见的相机参数。 */
export function computeFit({
  nodes,
  positions,
  radiusOf,
  viewport,
  pad = 90,
  limits = { min: ZOOM_LIMITS.min, max: 2 },
}) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let any = false
  for (const n of nodes) {
    const p = positions.get(n.id)
    if (!p) continue
    any = true
    const r = radiusOf(n.id)
    minX = Math.min(minX, p.x - r); maxX = Math.max(maxX, p.x + r)
    minY = Math.min(minY, p.y - r); maxY = Math.max(maxY, p.y + r)
  }
  if (!any) return { x: 0, y: 0, zoom: 1 }

  const bw = Math.max(1, maxX - minX)
  const bh = Math.max(1, maxY - minY)
  const z = Math.min((viewport.w - pad * 2) / bw, (viewport.h - pad * 2) / bh)
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    zoom: Math.max(limits.min, Math.min(limits.max, z)),
  }
}

/** 工作区容器包围盒；交叠工作区的包围盒会真实相交。 */
/** 空工作区（还没有成员节点）也要占一块可见画布。 */
export const WORKSPACE_MIN_SIZE = { w: 340, h: 240 }

// ---------------- 页面（选项卡）视图 ----------------
// 工作区即页面：一个节点可属于多个页面。切页时只显示本页节点；
// 跨页连线在本页生成「幽灵节点」，点击可跳转到对方页面。

/** 节点是否属于某页面；wsId 为空表示「全部页面」。 */
export function isOnPage(members, nodeId, wsId) {
  if (!wsId) return true
  return members.some((m) => m.workspaceId === wsId && m.nodeId === nodeId)
}

/** 类别是视图筛选，不改变工作区成员和上下文路由。 */
export function nodeHasCategory(node, category) {
  if (!node || !category) return false
  return (Array.isArray(node.categories) ? node.categories : node.category ? [node.category] : []).includes(category)
}

/** 本页可见的节点 id 列表。 */
export function visibleNodeIds(nodes, members, wsId) {
  return nodes.filter((n) => isOnPage(members, n.id, wsId)).map((n) => n.id)
}

/**
 * 计算幽灵节点：跨页连线在本页的入口。
 * 幽灵沿宿主节点的外环、朝真实节点所在方向排布；同一宿主上的多个幽灵会扇形散开。
 * 返回 [{ id: 对方节点, hostId: 本页宿主, linkId, x, y }]。
 */
export function computeGhosts({ links, members, positions, activeWs, radiusOf, gap = 48 }) {
  if (!activeWs) return []
  const on = (id) => isOnPage(members, id, activeWs)

  const byHost = new Map()
  for (const link of links) {
    const aVis = on(link.from)
    const bVis = on(link.to)
    if (aVis === bVis) continue // 两端都在或都不在，不产生幽灵
    const hostId = aVis ? link.from : link.to
    const otherId = aVis ? link.to : link.from
    if (!byHost.has(hostId)) byHost.set(hostId, new Map())
    byHost.get(hostId).set(otherId, link.id)
  }

  const out = []
  for (const [hostId, others] of byHost) {
    const hp = positions.get(hostId)
    if (!hp) continue
    const entries = [...others.entries()]
    entries.forEach(([otherId, linkId], i) => {
      const op = positions.get(otherId)
      let ang = op ? Math.atan2(op.y - hp.y, op.x - hp.x) : (i / entries.length) * Math.PI * 2
      if (entries.length > 1 && op) ang += (i - (entries.length - 1) / 2) * 0.55
      const dist = radiusOf(hostId) + gap
      out.push({
        id: otherId,
        hostId,
        linkId,
        x: hp.x + Math.cos(ang) * dist,
        y: hp.y + Math.sin(ang) * dist,
      })
    })
  }
  return out
}

/** 两个矩形的最小外接矩形。 */
export function unionRect(a, b) {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  }
}

/**
 * 工作区画布框：
 *  - 有成员节点 → 成员包围盒（含 padding）
 *  - 空工作区 → 以 origin 为左上角的最小画布
 *  - 两者都有 → 取并集，避免节点被画到框外
 */
export function workspaceBounds({
  members,
  positions,
  workspaceId,
  pad = 58,
  origin = null,
  minSize = WORKSPACE_MIN_SIZE,
}) {
  const ids = members.filter((m) => m.workspaceId === workspaceId).map((m) => m.nodeId)
  const pts = ids.map((id) => positions.get(id)).filter(Boolean)

  // 有成员：以成员包围盒为准（origin 只对空工作区生效，避免框被拉得过大）
  if (pts.length === 0) {
    return origin ? { x: origin.x, y: origin.y, w: minSize.w, h: minSize.h } : null
  }

  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  return {
    x: Math.min(...xs) - pad,
    y: Math.min(...ys) - pad,
    w: Math.max(...xs) - Math.min(...xs) + pad * 2,
    h: Math.max(...ys) - Math.min(...ys) + pad * 2,
  }
}

export function boundsIntersect(a, b) {
  if (!a || !b) return false
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** 点到线段的距离，用于连线的命中测试（世界坐标）。 */
export function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-9) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * 连线命中测试：返回距离最近且在容差内的连线。
 * 容差以世界坐标给出，调用方需按 zoom 换算，保证屏幕上手感一致。
 */
export function hitTestLink({ links, positions, world, tolerance, radiusOf }) {
  let best = null
  let bestDist = Infinity
  for (const link of links) {
    const a = positions.get(link.from)
    const b = positions.get(link.to)
    if (!a || !b) continue
    const d = distanceToSegment(world.x, world.y, a.x, a.y, b.x, b.y)
    // 命中点不应落在节点圆内，否则会与节点点击冲突
    const insideA = Math.hypot(world.x - a.x, world.y - a.y) <= (radiusOf?.(link.from) ?? 0)
    const insideB = Math.hypot(world.x - b.x, world.y - b.y) <= (radiusOf?.(link.to) ?? 0)
    if (insideA || insideB) continue
    if (d <= tolerance && d < bestDist) {
      best = link
      bestDist = d
    }
  }
  return best
}

/** 连线中点，用于放置连线详情面板。 */
export function linkMidpoint(positions, link) {
  const a = positions.get(link.from)
  const b = positions.get(link.to)
  if (!a || !b) return null
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/** 详情面板定位：锚定节点旁，越界自动翻转，并夹紧在视口内。 */
export function anchorPanel({ nodeScreen, nodeRadiusPx, panel, viewport, margin = 12, offset = 18 }) {
  let left = nodeScreen.x + nodeRadiusPx + offset
  if (left + panel.w > viewport.w - margin) {
    left = nodeScreen.x - nodeRadiusPx - offset - panel.w
  }
  left = Math.max(margin, Math.min(left, Math.max(margin, viewport.w - panel.w - margin)))
  const top = Math.max(margin, Math.min(nodeScreen.y - panel.h / 2, Math.max(margin, viewport.h - panel.h - margin)))
  return { left, top }
}
