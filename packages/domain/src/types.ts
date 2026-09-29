export type NodeId = string
export type WorkspaceId = string
export type LinkId = string

export type NodeKind = "session" | "summary" | "hub" | "document" | "notebook"
export type NodeLifecycle = "active" | "idle" | "compressed" | "archived"
export type LinkKind = "reference" | "dependency" | "portal" | "fork" | "merge"
export type LoadTier = "hard" | "soft" | "portal"

/** 2D/3D 共用语义坐标；视图布局单独保存。 */
export interface SemanticCoord {
  x: number
  y: number
  z: number
}

export interface ViewLayout {
  /** 视图标识，例如 "2d-canvas" / "3d-space" */
  viewId: string
  position: SemanticCoord
  /** 用户是否手动锁定位置，自动布局不得覆盖 */
  pinned: boolean
}

export interface NodeSummary {
  text: string
  /** 摘要版本，Portal 快照必须固定版本 */
  version: number
  model?: string
  /** 摘要来源：AI 生成、手动填写或系统压缩 */
  source?: "ai" | "manual" | "compress"
  createdAt: string
}

export interface GraphNode {
  id: NodeId
  kind: NodeKind
  title: string
  /** 首个类别的旧接口映射；实际归属以 categories 为准。 */
  category: string
  categories: string[]
  /** 人工或 AI 附加的标签 */
  tags: string[]
  lifecycle: NodeLifecycle
  /** 关联的 OpenCode 会话；summary/hub 节点可为空 */
  opencodeSessionId?: string
  /** 用于节点尺寸映射的对数输入 */
  tokenCount: number
  /** 语义坐标：由 embedding 降维得到 */
  semantic: SemanticCoord | null
  layouts: Record<string, ViewLayout>
  summaries: NodeSummary[]
  /** 附加元数据：项目路径、标签、来源 */
  meta: Record<string, unknown>
  createdAt: string
  updatedAt: string
  /** 最近一次观察到运行时会话执行中的时间；编辑节点元数据不会刷新它。 */
  lastActiveAt?: string
}

export interface GraphLink {
  id: LinkId
  kind: LinkKind
  from: NodeId
  to: NodeId
  directed: boolean
  /**
   * Portal 只允许读取该快照，禁止穿透全文。
   * 非 portal 链路可为空。
   */
  snapshot?: NodeSummary
  meta: Record<string, unknown>
  createdAt: string
}

export interface Workspace {
  id: WorkspaceId
  name: string
  /** 注入圈内节点的 System Prompt 与全局变量 */
  systemPrompt: string
  variables: Record<string, string>
  /** 视图上的容器几何；true 为 2D 大圈，false 为 3D 气泡 */
  flat: boolean
  color: string
  /**
   * 画布框左上角（世界坐标）。空工作区没有成员节点，
   * 靠它才能作为一块独立画布可见，并支持跨画布连线。
   * 缺省时由前端按顺序补一个空位，保证旧数据也能显示。
   */
  origin?: { x: number; y: number }
  /**
   * 工作区绑定的本地目录（用于目录浏览的「本工作区」筛选）。
   * 缺省时按工作区内节点引用过的文件筛选。
   */
  dir?: string
  createdAt: string
  updatedAt: string
}

/**
 * 节点与工作区为多对多，才能表达 2D/3D 相交区域的双重归属。
 * workspaceId 不应作为 node 的单一父字段。
 */
export interface WorkspaceMember {
  workspaceId: WorkspaceId
  nodeId: NodeId
  /** 是否位于多个工作区的交叠区 */
  overlap: boolean
  addedAt: string
}
