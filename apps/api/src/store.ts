import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { GraphLink, GraphNode, Workspace, WorkspaceMember } from "@nodex/domain"

/**
 * NodeX 自己的图谱持久化。
 * 不写 OpenCode 数据库；只保存 NodeX 领域对象与会话 ID 引用。
 */
/** NodeX 全局设置（不属于图谱本身）。 */
export interface NodexSettings {
  /** 全局默认主模型；缺省时退回运行时配置默认 */
  defaultModel?: { providerID: string; modelID: string }
  /** 文件预览允许的根目录；缺省时用进程工作目录 */
  filesRoot?: string
  /** 上下文用量上限（tokens），用于会话窗用量填充与压缩提示；默认 300k */
  contextLimit?: number
  /** 达到上下文上限时自动执行 /compact（OpenCode 原生压缩） */
  autoCompact?: boolean
  /**
   * NodeX 直连模型配置（摘要 / 元数据等）。apiKey 仅存本地数据目录，
   * 不进入源码或仓库；接口只返回脱敏值。
   */
  ai?: {
    baseUrl?: string
    apiKey?: string
    model?: string
    systemPrompt?: string
  }
}

export interface LayoutTemplateSlot {
  key: string
  label: string
  x: number
  y: number
  nodeId?: string
}

export interface LayoutTemplateLink {
  from: string
  to: string
  kind?: GraphLink["kind"]
  directed?: boolean
}

export interface LayoutTemplate {
  id: string
  name: string
  description: string
  builtin?: boolean
  slots: LayoutTemplateSlot[]
  links: LayoutTemplateLink[]
  createdAt: string
  updatedAt: string
}

export interface CollaborationInstance {
  id: string
  name: string
  kind: "three-ministries" | "brainstorm" | "debate"
  config: { layers?: number[]; agents?: number; sides?: number; perSide?: number }
  workspaceId?: string
  slots: LayoutTemplateSlot[]
  links: LayoutTemplateLink[]
  mainKey: string
  instructions?: Record<string, string>
  ownedNodeIds: string[]
  createdAt: string
  updatedAt: string
}

export interface PersistedGraph {
  /** 持久化格式版本；结构变化时递增，载入时按需迁移。 */
  schemaVersion?: number
  nodes: GraphNode[]
  links: GraphLink[]
  workspaces: Workspace[]
  members: WorkspaceMember[]
  templates?: LayoutTemplate[]
  collaborations?: CollaborationInstance[]
  settings?: NodexSettings
}

/** 图谱持久化格式版本；结构变化时在此递增并补迁移分支。 */
export const GRAPH_SCHEMA_VERSION = 1

const EMPTY: PersistedGraph = { schemaVersion: GRAPH_SCHEMA_VERSION, nodes: [], links: [], workspaces: [], members: [], templates: [], collaborations: [], settings: {} }

function normalizedNode(node: GraphNode): GraphNode {
  const values = Array.isArray(node.categories) ? node.categories : [node.category]
  const categories = [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))]
  return { ...node, categories, category: categories[0] ?? "" }
}

/**
 * 载入时的迁移：把旧版 graph.json 归一化到当前 schema。
 * 无版本（早期文件）视为 0。未来版本升级时在此按 from 逐版本处理。
 */
function migrateGraph(raw: unknown): PersistedGraph {
  const source = (raw && typeof raw === "object" ? raw : {}) as Partial<PersistedGraph>
  const from = typeof source.schemaVersion === "number" ? source.schemaVersion : 0
  const data: PersistedGraph = { ...structuredClone(EMPTY), ...source }
  if (from < 1) data.nodes = (data.nodes ?? []).map(normalizedNode)
  data.schemaVersion = GRAPH_SCHEMA_VERSION
  return data
}

export class GraphStore {
  private data: PersistedGraph = structuredClone(EMPTY)

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        this.data = migrateGraph(JSON.parse(readFileSync(file, "utf8")))
      } catch {
        this.data = structuredClone(EMPTY)
      }
    }
  }

  private persist() {
    mkdirSync(dirname(this.file), { recursive: true })
    this.data.schemaVersion = GRAPH_SCHEMA_VERSION
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }

  snapshot(): PersistedGraph {
    return structuredClone(this.data)
  }

  upsertNode(node: GraphNode): GraphNode {
    node = normalizedNode(node)
    const i = this.data.nodes.findIndex((n) => n.id === node.id)
    if (i >= 0) this.data.nodes[i] = node
    else this.data.nodes.push(node)
    this.persist()
    return node
  }

  patchNode(id: string, patch: Partial<GraphNode>): GraphNode | null {
    const i = this.data.nodes.findIndex((n) => n.id === id)
    if (i < 0) return null
    const updated = { ...this.data.nodes[i], ...patch, updatedAt: new Date().toISOString() }
    if ("category" in patch && !("categories" in patch)) updated.categories = [updated.category]
    this.data.nodes[i] = normalizedNode(updated)
    this.persist()
    return this.data.nodes[i]
  }

  setNodeLastActive(id: string, at: string): void {
    const node = this.data.nodes.find((n) => n.id === id)
    if (!node) return
    node.lastActiveAt = at
    this.persist()
  }

  deleteNode(id: string): boolean {
    const before = this.data.nodes.length
    this.data.nodes = this.data.nodes.filter((n) => n.id !== id)
    this.data.links = this.data.links.filter((l) => l.from !== id && l.to !== id)
    this.data.members = this.data.members.filter((m) => m.nodeId !== id)
    for (const instance of this.data.collaborations ?? []) {
      for (const slot of instance.slots) if (slot.nodeId === id) delete slot.nodeId
      instance.ownedNodeIds = instance.ownedNodeIds.filter((nodeId) => nodeId !== id)
    }
    if (this.data.nodes.length === before) return false
    this.persist()
    return true
  }

  node(id: string): GraphNode | null {
    return this.data.nodes.find((n) => n.id === id) ?? null
  }

  upsertWorkspace(ws: Workspace): Workspace {
    const i = this.data.workspaces.findIndex((w) => w.id === ws.id)
    if (i >= 0) this.data.workspaces[i] = ws
    else this.data.workspaces.push(ws)
    this.persist()
    return ws
  }

  workspace(id: string): Workspace | null {
    return this.data.workspaces.find((w) => w.id === id) ?? null
  }

  deleteWorkspace(id: string): boolean {
    const before = this.data.workspaces.length
    this.data.workspaces = this.data.workspaces.filter((w) => w.id !== id)
    this.data.members = this.data.members.filter((m) => m.workspaceId !== id)
    if (this.data.workspaces.length === before) return false
    this.persist()
    return true
  }

  upsertLink(link: GraphLink): GraphLink {
    const i = this.data.links.findIndex((l) => l.id === link.id)
    if (i >= 0) this.data.links[i] = link
    else this.data.links.push(link)
    this.persist()
    return link
  }

  setMembers(members: WorkspaceMember[]): WorkspaceMember[] {
    this.data.members = members
    this.persist()
    return members
  }

  setLinks(links: GraphLink[]): GraphLink[] {
    this.data.links = links
    this.persist()
    return links
  }

  settings(): NodexSettings {
    return this.data.settings ?? {}
  }

  patchSettings(patch: Partial<NodexSettings>): NodexSettings {
    this.data.settings = { ...(this.data.settings ?? {}), ...patch }
    for (const key of Object.keys(this.data.settings) as (keyof NodexSettings)[]) {
      if (this.data.settings[key] === undefined) delete this.data.settings[key]
    }
    this.persist()
    return this.data.settings
  }

  templates(): LayoutTemplate[] {
    return structuredClone(this.data.templates ?? [])
  }

  upsertTemplate(template: LayoutTemplate): LayoutTemplate {
    const templates = this.data.templates ?? []
    const index = templates.findIndex((item) => item.id === template.id)
    if (index >= 0) templates[index] = template
    else templates.push(template)
    this.data.templates = templates
    this.persist()
    return template
  }

  deleteTemplate(id: string): boolean {
    const before = (this.data.templates ?? []).length
    this.data.templates = (this.data.templates ?? []).filter((item) => item.id !== id || item.builtin)
    if (this.data.templates.length === before) return false
    this.persist()
    return true
  }

  collaborations(): CollaborationInstance[] {
    return structuredClone(this.data.collaborations ?? [])
  }

  upsertCollaboration(instance: CollaborationInstance): CollaborationInstance {
    const list = this.data.collaborations ?? []
    const index = list.findIndex((item) => item.id === instance.id)
    if (index >= 0) list[index] = instance
    else list.push(instance)
    this.data.collaborations = list
    this.persist()
    return structuredClone(instance)
  }

  deleteCollaboration(id: string): boolean {
    const before = (this.data.collaborations ?? []).length
    this.data.collaborations = (this.data.collaborations ?? []).filter((instance) => instance.id !== id)
    if (before === this.data.collaborations.length) return false
    this.persist()
    return true
  }
}

export function defaultStorePath(): string {
  const dir = process.env.NODEX_DATA_DIR ?? resolve(process.cwd(), "runs")
  return resolve(dir, "graph.json")
}
