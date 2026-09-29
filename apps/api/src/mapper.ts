import type { GraphState, GraphNode, Workspace, WorkspaceMember } from "@nodex/domain"
import { emptyGraph, addLink, addNode, addWorkspace, joinWorkspace } from "@nodex/domain"
import type { PersistedGraph } from "./store.ts"

/** 将持久化快照还原为内存图谱，供上下文路由使用。 */
export function toGraphState(p: PersistedGraph): GraphState {
  const g = emptyGraph()
  for (const ws of p.workspaces) addWorkspace(g, ws)
  for (const node of p.nodes) addNode(g, node)
  for (const link of p.links) addLink(g, link)
  for (const m of p.members) {
    joinWorkspace(g, m.workspaceId, m.nodeId, m.addedAt)
  }
  // joinWorkspace 会重算 overlap，此处以持久化标记为准做一次校正
  const overlapSet = new Set(p.members.filter((m) => m.overlap).map((m) => `${m.workspaceId}:${m.nodeId}`))
  for (const m of g.members) {
    if (overlapSet.has(`${m.workspaceId}:${m.nodeId}`)) m.overlap = true
  }
  return g
}

export function newNode(input: {
  id: string
  title: string
  opencodeSessionId?: string
  category?: string
  categories?: string[]
  tags?: string[]
  kind?: GraphNode["kind"]
}): GraphNode {
  const now = new Date().toISOString()
  const categories = input.categories ?? (input.category ? [input.category] : [])
  return {
    id: input.id,
    kind: input.kind ?? "session",
    title: input.title,
    category: categories[0] ?? "",
    categories: [...categories],
    tags: input.tags ?? [],
    lifecycle: "active",
    opencodeSessionId: input.opencodeSessionId,
    tokenCount: 0,
    semantic: null,
    layouts: {},
    summaries: [],
    meta: {},
    createdAt: now,
    updatedAt: now,
  }
}

/** 追加一版摘要；版本号单调递增，供 Portal 固定引用。 */
export function appendSummary(
  node: GraphNode,
  text: string,
  source: "ai" | "manual" | "compress" = "ai",
  model?: string,
): GraphNode["summaries"] {
  return [
    ...node.summaries,
    { text, version: node.summaries.length + 1, source, model, createdAt: new Date().toISOString() },
  ]
}

export function newWorkspace(input: {
  id: string
  name: string
  systemPrompt?: string
  color?: string
  origin?: { x: number; y: number }
  dir?: string
}): Workspace {
  const now = new Date().toISOString()
  return {
    id: input.id,
    name: input.name,
    systemPrompt: input.systemPrompt ?? "",
    variables: {},
    flat: true,
    color: input.color ?? "#6366f1",
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.dir ? { dir: input.dir } : {}),
    createdAt: now,
    updatedAt: now,
  }
}

export function memberOf(workspaceId: string, nodeId: string, overlap: boolean): WorkspaceMember {
  return { workspaceId, nodeId, overlap, addedAt: new Date().toISOString() }
}
