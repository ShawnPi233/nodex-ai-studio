import type {
  GraphLink,
  GraphNode,
  NodeId,
  WorkspaceId,
  WorkspaceMember,
} from "./types.ts"

export interface GraphState {
  nodes: Map<NodeId, GraphNode>
  links: Map<string, GraphLink>
  workspaces: Map<WorkspaceId, Workspace>
  members: WorkspaceMember[]
}

import type { Workspace } from "./types.ts"

export function emptyGraph(): GraphState {
  return {
    nodes: new Map(),
    links: new Map(),
    workspaces: new Map(),
    members: [],
  }
}

export function addNode(graph: GraphState, node: GraphNode): GraphState {
  graph.nodes.set(node.id, node)
  return graph
}

export function addWorkspace(graph: GraphState, ws: Workspace): GraphState {
  graph.workspaces.set(ws.id, ws)
  return graph
}

export function addLink(graph: GraphState, link: GraphLink): GraphState {
  graph.links.set(link.id, link)
  return graph
}

/**
 * 拖入工作区：继承 System Prompt 与变量。
 * 若节点已属于其他工作区，则标记为交叠成员。
 */
export function joinWorkspace(
  graph: GraphState,
  workspaceId: WorkspaceId,
  nodeId: NodeId,
  at: string,
): GraphState {
  const existing = graph.members.filter((m) => m.nodeId === nodeId)
  const already = existing.some((m) => m.workspaceId === workspaceId)
  if (already) return graph

  graph.members.push({
    workspaceId,
    nodeId,
    overlap: existing.length > 0,
    addedAt: at,
  })

  // 已在交叠区的节点，其所有成员关系都要重算 overlap 标记
  if (existing.length > 0) {
    for (const m of graph.members) {
      if (m.nodeId === nodeId) m.overlap = true
    }
  }
  return graph
}

/** 拖出工作区：剥离该工作区的全局背景，回归独立会话。 */
export function leaveWorkspace(
  graph: GraphState,
  workspaceId: WorkspaceId,
  nodeId: NodeId,
): GraphState {
  graph.members = graph.members.filter(
    (m) => !(m.workspaceId === workspaceId && m.nodeId === nodeId),
  )
  const rest = graph.members.filter((m) => m.nodeId === nodeId)
  for (const m of rest) m.overlap = rest.length > 1
  return graph
}

export function workspacesOf(graph: GraphState, nodeId: NodeId): WorkspaceId[] {
  return graph.members
    .filter((m) => m.nodeId === nodeId)
    .map((m) => m.workspaceId)
}

export function membersOf(graph: GraphState, workspaceId: WorkspaceId): NodeId[] {
  return graph.members
    .filter((m) => m.workspaceId === workspaceId)
    .map((m) => m.nodeId)
}

/** 交叠区节点：位于两个及以上工作区。 */
export function overlapNodes(graph: GraphState): NodeId[] {
  const counts = new Map<NodeId, number>()
  for (const m of graph.members) {
    counts.set(m.nodeId, (counts.get(m.nodeId) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, c]) => c > 1).map(([id]) => id)
}

/** 节点尺寸映射：token 数取对数，避免长会话撑爆画布。 */
export function nodeRadius(tokenCount: number, min = 8, max = 64): number {
  const safe = Math.max(0, tokenCount)
  const t = Math.log1p(safe) / Math.log1p(200_000)
  return min + (max - min) * Math.min(1, t)
}
