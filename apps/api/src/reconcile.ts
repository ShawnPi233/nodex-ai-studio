/**
 * 原生会话 reconcile 的纯逻辑：
 *  - 找出图中会话已不存在的节点（原生删除后残留在图里）；
 *  - 依据 OpenCode 返回的 parentId 补齐 fork 血缘链接（原生 fork 多为 NULL，
 *    只有携带 parentId 的会话才可可靠捕获）。
 * 与服务解耦，便于单测。
 */
export interface ReconcileNode {
  id: string
  opencodeSessionId: string
}

export interface ReconcileSession {
  id: string
  parentId?: string
}

export interface ReconcilePlan {
  /** 会话已不在运行时的节点 id（应被标记为缺失）。 */
  missingNodeIds: string[]
  /** 会话仍存在的节点 id（应清除缺失标记）。 */
  okNodeIds: string[]
  /** 需要补齐的 fork 血缘链接（父节点 -> 子节点）。 */
  forkLinks: Array<{ fromNodeId: string; toNodeId: string }>
}

export function planReconcile(nodes: ReconcileNode[], sessions: ReconcileSession[]): ReconcilePlan {
  const sessionIds = new Set(sessions.map((session) => session.id))
  const nodeBySession = new Map(nodes.map((node) => [node.opencodeSessionId, node.id]))

  const missingNodeIds: string[] = []
  const okNodeIds: string[] = []
  for (const node of nodes) {
    if (sessionIds.has(node.opencodeSessionId)) okNodeIds.push(node.id)
    else missingNodeIds.push(node.id)
  }

  const seen = new Set<string>()
  const forkLinks: Array<{ fromNodeId: string; toNodeId: string }> = []
  for (const session of sessions) {
    if (!session.parentId) continue
    const fromNodeId = nodeBySession.get(session.parentId)
    const toNodeId = nodeBySession.get(session.id)
    if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) continue
    const key = `${fromNodeId}->${toNodeId}`
    if (seen.has(key)) continue
    seen.add(key)
    forkLinks.push({ fromNodeId, toNodeId })
  }

  return { missingNodeIds, okNodeIds, forkLinks }
}
