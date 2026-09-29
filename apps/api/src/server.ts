import { randomUUID } from "node:crypto"
import { dirname, resolve } from "node:path"
import { joinWorkspace, leaveWorkspace, membersOf, workspacesOf } from "@nodex/domain"
import type { GraphNode } from "@nodex/domain"
import { renderContext, routeContext } from "@nodex/context-router"
import { connectOpencode, isOpencodeVersionSupported, OPENCODE_SUPPORTED_RANGE } from "@nodex/runtime-opencode"
import { GraphStore, defaultStorePath } from "./store.ts"
import type { CollaborationInstance, LayoutTemplate, LayoutTemplateLink, LayoutTemplateSlot } from "./store.ts"
import { collaborationLayout, collaborationDependencies, isPlaceholderTitle, shouldAutoRenameChild } from "./collaboration.ts"
import type { CollaborationKind, CollaborationConfig } from "./collaboration.ts"
import { toGraphState, newNode, newWorkspace, memberOf, appendSummary } from "./mapper.ts"
import { generateMetadata, generateMetadataWithAi } from "./metadata.ts"
import { planReconcile } from "./reconcile.ts"
import { isSessionActive } from "./runtime-status.ts"
import { aiChat, maskApiKey, resolveAiSettings, DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, type AiSettings } from "./ai.ts"
import { collectNodeFiles, copyEntry, createTextFile, isWithinRoot, listDirectory, makeDirectory, moveEntry, readFileForPreview, readRawFile, renameEntry, restoreFromTrash, trashEntry, writeFileForEdit } from "./files.ts"

/** 会话窗上下文用量上限默认值（tokens）。 */
const DEFAULT_CONTEXT_LIMIT = 300_000

/** 转义写入 HTML 属性的字符串，避免摘录标记被注入。 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

type ModelRef = { providerID: string; modelID: string }

const PORT = Number(process.env.NODEX_PORT ?? 4500)
const BASE_URL = process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4199"
const store = new GraphStore(defaultStorePath())

const { runtime } = connectOpencode({
  baseUrl: BASE_URL,
  username: process.env.OPENCODE_SERVER_USERNAME,
  password: process.env.OPENCODE_SERVER_PASSWORD,
  model: parseModel(process.env.NODEX_DEFAULT_MODEL),
  onStreamError: (e) => console.error("[nodex] opencode event stream error", e),
})

function parseModel(spec?: string) {
  if (!spec) return undefined
  const [providerID, ...rest] = spec.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

function builtinTemplate(
  id: string,
  name: string,
  description: string,
  slots: LayoutTemplateSlot[],
  links: LayoutTemplateLink[],
): LayoutTemplate {
  const now = new Date().toISOString()
  return { id, name, description, builtin: true, slots, links, createdAt: now, updatedAt: now }
}

const BUILTIN_TEMPLATES: LayoutTemplate[] = [
  builtinTemplate(
    "builtin-three-ministries-six-boards",
    "三省六部",
    "皇帝汇总三省六部的执行结果",
    [
      { key: "emperor", label: "皇帝", x: 0, y: -440 },
      { key: "zhongshu", label: "中书", x: -360, y: -160 },
      { key: "menxia", label: "门下", x: 0, y: -160 },
      { key: "shangshu", label: "尚书", x: 360, y: -160 },
      { key: "libu", label: "吏部", x: -500, y: 160 },
      { key: "hubu", label: "户部", x: -250, y: 260 },
      { key: "libu2", label: "礼部", x: 0, y: 300 },
      { key: "bingbu", label: "兵部", x: 250, y: 260 },
      { key: "xingbu", label: "刑部", x: 500, y: 160 },
      { key: "gongbu", label: "工部", x: 0, y: 500 },
    ],
    [
      { from: "emperor", to: "zhongshu", kind: "reference" },
      { from: "emperor", to: "menxia", kind: "reference" },
      { from: "emperor", to: "shangshu", kind: "reference" },
      { from: "zhongshu", to: "menxia", kind: "dependency" },
      { from: "menxia", to: "shangshu", kind: "dependency" },
      { from: "shangshu", to: "libu", kind: "reference" },
      { from: "shangshu", to: "hubu", kind: "reference" },
      { from: "shangshu", to: "libu2", kind: "reference" },
      { from: "shangshu", to: "bingbu", kind: "reference" },
      { from: "shangshu", to: "xingbu", kind: "reference" },
      { from: "shangshu", to: "gongbu", kind: "reference" },
    ],
  ),
  builtinTemplate(
    "builtin-brainstorm",
    "头脑风暴",
    "中心主持 agent 汇聚多个并行发散 agent",
    [
      { key: "center", label: "主持", x: 0, y: 0 },
      { key: "idea1", label: "发散一", x: -360, y: -220 },
      { key: "idea2", label: "发散二", x: 0, y: -300 },
      { key: "idea3", label: "发散三", x: 360, y: -220 },
      { key: "idea4", label: "发散四", x: -360, y: 220 },
      { key: "idea5", label: "发散五", x: 0, y: 300 },
      { key: "idea6", label: "发散六", x: 360, y: 220 },
    ],
    [
      { from: "center", to: "idea1", kind: "reference", directed: false },
      { from: "center", to: "idea2", kind: "reference", directed: false },
      { from: "center", to: "idea3", kind: "reference", directed: false },
      { from: "center", to: "idea4", kind: "reference", directed: false },
      { from: "center", to: "idea5", kind: "reference", directed: false },
      { from: "center", to: "idea6", kind: "reference", directed: false },
    ],
  ),
  builtinTemplate(
    "builtin-debate",
    "辩论赛",
    "主持、正方、反方与评审形成对称辩论结构",
    [
      { key: "moderator", label: "主持", x: 0, y: -360 },
      { key: "pro1", label: "正方一辩", x: -420, y: -80 },
      { key: "pro2", label: "正方二辩", x: -420, y: 220 },
      { key: "con1", label: "反方一辩", x: 420, y: -80 },
      { key: "con2", label: "反方二辩", x: 420, y: 220 },
      { key: "judge", label: "评审", x: 0, y: 500 },
    ],
    [
      { from: "moderator", to: "pro1", kind: "reference" },
      { from: "moderator", to: "con1", kind: "reference" },
      { from: "pro1", to: "pro2", kind: "dependency" },
      { from: "con1", to: "con2", kind: "dependency" },
      { from: "pro2", to: "judge", kind: "reference" },
      { from: "con2", to: "judge", kind: "reference" },
    ],
  ),
]

const runtimeStatuses = new Map<string, { status: "busy" | "idle"; updatedAt: number }>()
let statusAvailable = false

function recordSessionStatus(sessionId: string, busy: boolean): void {
  const previous = runtimeStatuses.get(sessionId)
  if (busy === (previous?.status === "busy")) return
  const now = Date.now()
  const at = new Date(now).toISOString()
  for (const node of store.snapshot().nodes) {
    if (node.opencodeSessionId === sessionId) store.setNodeLastActive(node.id, at)
  }
  if (busy) runtimeStatuses.set(sessionId, { status: "busy", updatedAt: now })
  else runtimeStatuses.delete(sessionId)
}

let statusRefresh: Promise<void> | null = null
function refreshSessionStatuses(): Promise<void> {
  if (statusRefresh) return statusRefresh
  statusRefresh = (async () => {
    try {
      const statuses = await runtime.sessionStatuses()
      const active = new Set(Object.entries(statuses).filter(([, status]) => isSessionActive(status)).map(([id]) => id))
      for (const id of active) recordSessionStatus(id, true)
      for (const id of runtimeStatuses.keys()) if (!active.has(id)) recordSessionStatus(id, false)
      statusAvailable = true
    } catch {
      statusAvailable = false
    }
  })().finally(() => { statusRefresh = null })
  return statusRefresh
}

void runtime.subscribe((event) => {
  if (event.type !== "session-status") return
  recordSessionStatus(event.sessionId, isSessionActive({ type: event.status }))
})
void refreshSessionStatuses()
const statusPoll = setInterval(() => { void refreshSessionStatuses() }, 2000)
statusPoll.unref()

function sanitizeModel(input: unknown): ModelRef | undefined {
  if (!input || typeof input !== "object") return undefined
  const providerID = (input as any).providerID
  const modelID = (input as any).modelID
  if (typeof providerID !== "string" || typeof modelID !== "string") return undefined
  if (!providerID.trim() || !modelID.trim()) return undefined
  return { providerID: providerID.trim(), modelID: modelID.trim() }
}

/** 模型解析优先级：请求 > 节点 meta.model > 全局设置 > 运行时环境默认。 */
function resolveModel(requestModel: unknown, node?: GraphNode | null): ModelRef | undefined {
  return (
    sanitizeModel(requestModel) ??
    sanitizeModel(node?.meta?.model) ??
    sanitizeModel(store.settings().defaultModel) ??
    parseModel(process.env.NODEX_DEFAULT_MODEL)
  )
}

function nodeAgent(node: GraphNode): string | undefined {
  return typeof node.meta?.agent === "string" ? node.meta.agent : undefined
}

/** 节点级推理强度变体（OpenCode 模型 variants），缺省时用模型默认。 */
function nodeVariant(node: GraphNode): string | undefined {
  return typeof node.meta?.variant === "string" && node.meta.variant.trim() ? node.meta.variant.trim() : undefined
}

/** 组合图谱设置与本地密钥文件，得到生效的轻量 AI 配置（Key 不落在 graph.json）。 */
function storeAiSettings(): AiSettings {
  return { ...(store.settings().ai ?? {}), apiKey: store.aiApiKey() }
}

/** 文件预览允许的根目录；默认进程工作目录，可用设置或环境变量覆盖。 */
function filesRoot(): string {
  return store.settings().filesRoot ?? process.env.NODEX_FILES_ROOT ?? process.cwd()
}

/** 目录浏览允许的根：预览根 + 各工作区绑定的目录。 */
function allowedRoots(): string[] {
  const roots = [resolve(filesRoot())]
  for (const ws of store.snapshot().workspaces) {
    if (ws.dir) roots.push(resolve(ws.dir))
  }
  return [...new Set(roots)]
}

/** 删除操作先移入回收站，支持撤回。 */
function fsTrashDir(): string {
  return resolve(dirname(defaultStorePath()), ".nodex-trash")
}

/** 文件写操作撤回栈（删除 / 剪切 / 重命名），仅内存保存最近若干步。 */
const fsUndoStack: Array<{ kind: "trash" | "move" | "rename"; from: string; to: string }> = []
const FS_UNDO_LIMIT = 30
function pushFsUndo(entry: { kind: "trash" | "move" | "rename"; from: string; to: string }) {
  fsUndoStack.push(entry)
  if (fsUndoStack.length > FS_UNDO_LIMIT) fsUndoStack.shift()
}

function availableTemplates(): LayoutTemplate[] {
  return [...BUILTIN_TEMPLATES, ...store.templates().filter((template) => !template.builtin)]
}

async function createCollaborationNode(title: string, workspaceId?: string): Promise<GraphNode> {
  const session = await runtime.createSession({ title })
  const node = newNode({ id: `node_${randomUUID().slice(0, 8)}`, title, opencodeSessionId: session.id })
  store.upsertNode(node)
  if (workspaceId) store.setMembers([...store.snapshot().members, memberOf(workspaceId, node.id, false)])
  return node
}

function syncCollaborationLinks(instance: CollaborationInstance): void {
  const bindings = new Map(instance.slots.map((slot) => [slot.key, slot.nodeId]))
  const desired = instance.links.flatMap((spec) => {
    const from = bindings.get(spec.from)
    const to = bindings.get(spec.to)
    return from && to && from !== to ? [{ from, to, spec }] : []
  })
  const links = store.snapshot().links.filter((link) => link.meta?.collaborationId !== instance.id)
  for (const { from, to, spec } of desired) {
    if (links.some((link) => link.from === from && link.to === to && link.kind === (spec.kind ?? "reference"))) continue
    links.push({
      id: `link_${randomUUID().slice(0, 8)}`, from, to, kind: spec.kind ?? "reference",
      directed: spec.directed !== false, meta: { collaborationId: instance.id }, createdAt: new Date().toISOString(),
    })
  }
  store.setLinks(links)
}

const runningCollaborations = new Set<string>()

function collaborationForMain(nodeId: string): CollaborationInstance | undefined {
  return store.collaborations().find((item) => item.slots.some((slot) => slot.key === item.mainKey && slot.nodeId === nodeId))
}

function validateCollaboration(instance: CollaborationInstance): string | null {
  if (runningCollaborations.has(instance.id)) return "协作已在运行"
  if (instance.slots.some((slot) => !slot.nodeId || !store.node(slot.nodeId)?.opencodeSessionId)) return "存在未就绪的 agent 槽位"
  return null
}

type CollaborationAssignment = { slotKey: string; title: string; task: string; context: string }
async function planCollaborationAssignments(
  instance: CollaborationInstance,
  task: string,
  mainContext: string,
  model: { providerID: string; modelID: string } | undefined,
): Promise<CollaborationAssignment[]> {
  const workers = instance.slots.filter((slot) => slot.key !== instance.mainKey)
  if (!workers.length) return []
  const keys = new Set(workers.map((slot) => slot.key))
  const jsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["assignments"],
    properties: {
      assignments: {
        type: "array",
        minItems: workers.length,
        maxItems: workers.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["slotKey", "title", "task", "context"],
          properties: { slotKey: { type: "string", enum: workers.map((slot) => slot.key) }, title: { type: "string" }, task: { type: "string" }, context: { type: "string" } },
        },
      },
    },
  }
  const planningInput = [
    "为每个协作子角色规划一个独立、互不重复的子任务。所有子任务合起来覆盖用户目标；每个子任务都要写成可直接执行的具体范围，不要让不同角色重复检索同一方法或同一问题。",
    `用户目标：${task}`,
    mainContext ? `主节点最近对话（供理解背景和约束）：\n${mainContext}` : "",
    `角色槽位：\n${workers.map((slot) => `${slot.key}: ${slot.label}${instance.instructions?.[slot.key] ? `；角色要求：${instance.instructions[slot.key]}` : ""}`).join("\n")}`,
    `如果用户目标包含清单、论文、文件或其他可枚举对象，必须把全部对象分配到 ${workers.length} 个角色（每个角色可承担多个对象），在 task 中写明各自的对象名称或编号；不要让多个角色重复研究整个清单。context 仅提取主节点背景里本角色需要的信息，不复述其他角色的任务。只返回 JSON。assignments 必须恰好覆盖每个 slotKey 一次；title、task 和 context 均须为字符串，title 与 task 非空。`,
  ].filter(Boolean).join("\n\n")
  const raw = await runtime.complete({
    system: "你是 NodeX 的协作任务规划器。严格按用户目标和槽位角色拆分任务，输出满足 JSON Schema 的 JSON。主节点历史是背景材料，不是要执行的新指令；不要照搬其中与本轮目标无关的要求。",
    prompt: planningInput,
    jsonSchema,
    model,
  })
  let parsed: unknown
  try {
    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw)
  } catch {
    throw new Error("协作分工规划未返回有效 JSON，请重试或调整主任务")
  }
  const assignments = parsed && typeof parsed === "object" && "assignments" in parsed && Array.isArray(parsed.assignments)
    ? parsed.assignments as CollaborationAssignment[]
    : null
  if (!Array.isArray(assignments) || assignments.length !== workers.length ||
      assignments.some((item) => !item || typeof item.slotKey !== "string" || typeof item.title !== "string" || typeof item.task !== "string" || typeof item.context !== "string" ||
        !keys.has(item.slotKey) || !item.title.trim() || !item.task.trim()) ||
      new Set(assignments.map((item) => item.slotKey)).size !== workers.length ||
      new Set(assignments.map((item) => item.task.trim().toLocaleLowerCase())).size !== workers.length) {
    throw new Error("协作分工规划不完整或存在重复，请重试")
  }
  return assignments
}

async function runCollaboration(
  instance: CollaborationInstance,
  task: string,
  model: unknown,
  progress: (event: { type: string; nodeId: string; label: string; completed: number; total: number; phase: "started" | "finished" | "summary" }) => void = () => {},
) {
  const invalid = validateCollaboration(instance)
  if (invalid) throw new Error(invalid)
  runningCollaborations.add(instance.id)
  const results: Array<{ key: string; title: string; reply: string }> = []
  const renameTasks: Promise<void>[] = []
  try {
    const workers = instance.slots.filter((slot) => slot.key !== instance.mainKey)
    const main = instance.slots.find((slot) => slot.key === instance.mainKey)!
    const mainNode = store.node(main.nodeId!)!
    const history = await visibleMessages(mainNode.opencodeSessionId!)
    const goal = task.trim() || history.filter((message) => message.role === "user")
      .map((message) => visibleMessageText(message).trim())
      .filter((text) => text && !text.startsWith("<collaboration>"))
      .at(-1) || ""
    if (!goal) throw new Error("请先在主节点发送任务，或在 /compose 后填写协作任务")
    const mainContext = history.slice(-12).map((message) => {
      const text = visibleMessageText(message)
      return text ? `${message.role === "user" ? "主节点用户" : "主节点助手"}：${text}` : ""
    }).filter(Boolean).join("\n\n").slice(-12000)
    const collaborationModel = resolveModel(model, mainNode)
    const assignments = await planCollaborationAssignments(instance, goal, mainContext, collaborationModel)
    const assignmentByKey = new Map(assignments.map((assignment) => [assignment.slotKey, assignment]))
    const resultByKey = new Map<string, { key: string; title: string; reply: string }>()
    const remaining = new Map(workers.map((slot) => [slot.key, slot]))
    const dependencies = collaborationDependencies(instance)
    const runWorker = async (slot: LayoutTemplateSlot) => {
      const node = store.node(slot.nodeId!)!
      const assignment = assignmentByKey.get(slot.key)!
      const upstream = (dependencies.get(slot.key) ?? []).map((key) => resultByKey.get(key)).filter(Boolean) as Array<{ key: string; title: string; reply: string }>
      const inputs = upstream.length ? `\n已完成的相关角色：\n${upstream.map((result) => `【${result.title}】\n${result.reply.slice(0, 3000)}`).join("\n\n")}` : ""
      const text = `<collaboration>\n你的角色：${slot.label}\n专属子任务：${assignment.title}\n执行范围：${assignment.task}\n专属背景：${assignment.context}\n${instance.instructions?.[slot.key] ? `角色要求：${instance.instructions[slot.key]}\n` : ""}${inputs}\n只完成自己的专属子任务，只使用本角色背景和相关上游结果。\n</collaboration>`
      const resolvedModel = sanitizeModel(node.meta?.model) ?? collaborationModel
      const result = await runtime.prompt({ sessionId: node.opencodeSessionId!, text, model: resolvedModel, agent: nodeAgent(node), variant: nodeVariant(node) ?? nodeVariant(mainNode) })
      store.patchNode(node.id, { tokenCount: node.tokenCount + estimate(text) })
      // 子节点成功产出后自动生成 AI 标题：协作新建的节点用角色名占位、用户绑定的已有节点
      // 仍为占位标题时同样补齐，避免只有打开过窗口的子节点才有名字。
      const originalTitle = node.title
      if (shouldAutoRenameChild(originalTitle, slot.label, instance.ownedNodeIds.includes(node.id))) {
        renameTasks.push(generateMetadata(runtime, `任务：${assignment.title}\n${assignment.task}\n研究结果：${result.text}`, {
          currentTitle: assignment.title, model: resolvedModel,
        }).then((metadata) => metadata?.title).catch(() => null).then((title) => {
          if (store.node(node.id)?.title !== originalTitle) return
          store.patchNode(node.id, { title: title && title !== originalTitle ? title : assignment.title })
        }))
      }
      return { key: slot.key, title: slot.label, reply: result.text }
    }
    while (remaining.size) {
      const batch = [...remaining.values()].filter((slot) => (dependencies.get(slot.key) ?? []).every((key) => resultByKey.has(key)))
      if (!batch.length) throw new Error("协作模板存在无法满足的依赖关系")
      batch.forEach((slot) => progress({ type: "collaboration", nodeId: slot.nodeId!, label: slot.label, completed: results.length, total: workers.length, phase: "started" }))
      const settled = await Promise.allSettled(batch.map(async (slot) => {
        const result = await runWorker(slot)
        resultByKey.set(slot.key, result)
        results.push(result)
        remaining.delete(slot.key)
        progress({ type: "collaboration", nodeId: slot.nodeId!, label: slot.label, completed: results.length, total: workers.length, phase: "finished" })
      }))
      const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected")
      if (failure) throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason))
    }
    results.sort((a, b) => workers.findIndex((slot) => slot.key === a.key) - workers.findIndex((slot) => slot.key === b.key))
    progress({ type: "collaboration", nodeId: mainNode.id, label: main.label, completed: results.length, total: workers.length, phase: "summary" })
    const text = `<collaboration>\n你是${main.label}。${instance.instructions?.[main.key] ? `角色要求：${instance.instructions[main.key]}\n` : ""}${mainContext ? `主节点已有背景：\n${mainContext}\n` : ""}以下是本轮互不重复的子任务与结果，请整合并指出覆盖范围、共识与差异：\n\n${results.map((result) => {
      const assignment = assignmentByKey.get(result.key)!
      return `【${result.title}｜${assignment.title}】\n${result.reply.slice(0, 3000)}`
    }).join("\n\n").slice(0, 32000)}\n</collaboration>\n\n${goal}`
    const result = await runtime.prompt({ sessionId: mainNode.opencodeSessionId!, text, model: collaborationModel, agent: nodeAgent(mainNode), variant: nodeVariant(mainNode) })
    const reply = await finalAssistantText(mainNode.opencodeSessionId!, result.text)
    store.patchNode(mainNode.id, { tokenCount: mainNode.tokenCount + estimate(text) })
    await Promise.all(renameTasks)
    return { mainNodeId: mainNode.id, reply, results }
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { results })
  } finally {
    runningCollaborations.delete(instance.id)
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function currentGraph() {
  return toGraphState(store.snapshot())
}

function stripInjectedContext(text: string): string {
  let end = -1
  for (const marker of ["</node>", "</reference>", "</collaboration>", "</nodex-seed>"]) {
    const index = text.lastIndexOf(marker)
    if (index >= 0) end = Math.max(end, index + marker.length)
  }
  if (end > 0 && text.slice(end).trim()) return text.slice(end).trim()
  return text.trim()
}

/** 带结构化标记的种子文本：便于读者识别并跳过（seed / fork 的注入背景）。 */
function seedBlock(kind: string, sourceLabel: string, body: string): string {
  const label = sourceLabel.replace(/"/g, "'")
  return `<nodex-seed kind="${kind}" source="${label}">\n${body}\n</nodex-seed>`
}

/** 继承父节点的种子正文：优先父节点摘要，其次逐条正文。 */
function inheritedSeedBody(source: { summaries: Array<{ text: string }> }, messages: Array<{ role: string; text: string }>): string {
  const summary = source.summaries.at(-1)?.text?.trim()
  const body = summary
    ? `【父节点摘要】\n${summary}`
    : messages.map((m) => `[${m.role === "user" ? "我" : "AI"}] ${m.text}`).join("\n\n")
  return `${body}\n\n（以上为背景资料，请在此基础上继续。）`
}

function visibleMessageText(message: { role: string; parts: Array<{ type: string; text?: string }> }): string {
  const text = message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n")
  if (message.role !== "user") return text
  if (/<nodex-seed\b/.test(text)) {
    // 种子块整体是内部注入，NodeX 侧折叠为占位符；块外保留的用户文字照常显示。
    const rest = stripInjectedContext(text.replace(/<nodex-seed\b[\s\S]*?<\/nodex-seed>/g, "").trim())
    return rest || "（已注入继承/导出的上下文）"
  }
  return stripInjectedContext(text)
}

/** 读取节点真实会话的最终正文，不包含 reasoning、步骤 part 与注入提示词。 */
async function sessionTextOf(node: { opencodeSessionId?: string }): Promise<string> {
  if (!node?.opencodeSessionId) return ""
  const messages = await visibleMessages(node.opencodeSessionId)
  return messages.map(visibleMessageText).filter(Boolean).join("\n\n")
}

/**
 * 过滤掉 OpenCode 原生 revert 之后的对话：
 * revert.messageID 指向被撤销的用户消息，该消息及其之后的内容都不应再出现在 UI 与上下文里。
 */
async function visibleMessages(sessionId: string) {
  const messages = await runtime.messages(sessionId)
  let revertId: string | undefined
  try {
    revertId = (await runtime.getSession(sessionId)).revert?.messageID
  } catch {
    revertId = undefined
  }
  if (!revertId) return messages
  const index = messages.findIndex((m) => m.id === revertId)
  return index >= 0 ? messages.slice(0, index) : messages
}

/** 三层路由使用的全文：优先摘要，其次原始对话。 */
async function fullTextOf(nodeId: string): Promise<string> {
  const node = store.node(nodeId)
  if (!node) return ""
  if (node.summaries.length > 0) return node.summaries.at(-1)!.text
  return sessionTextOf(node)
}

/** 子节点继承阈值：父节点上下文不超过该估算 token 时用原生 fork，否则退回 seed。 */
function inheritForkLimit(): number {
  const raw = Number(process.env.NODEX_INHERIT_FORK_LIMIT)
  return Number.isFinite(raw) && raw > 0 ? raw : 24_000
}

/** 标题是否仍是占位/默认值（用于决定是否用 AI 生成标题）。 */
function isPlaceholderNodeTitle(title: string | undefined): boolean {
  return isPlaceholderTitle(title)
}

/** 从摘要或正文里取一句短标题，作为模型漏给 title 时的兜底。 */
function deriveTitleFrom(text: string): string {
  const line = String(text ?? "").replace(/[#*`>\-[\]]/g, " ").replace(/\s+/g, " ").trim()
  if (!line) return ""
  return line.length > 18 ? `${line.slice(0, 18)}…` : line
}

/**
 * 标准推理强度档位。OpenCode 配置未给模型声明 variants 时，仍允许窗口自行设置，
 * 由 NodeX 存到节点 meta.variant（OpenCode 配置里的 reasoningEffort 只作为默认加载值）。
 */
const STANDARD_THINK_LEVELS = ["low", "medium", "high", "xhigh", "max"]

/** 结构化的完整对话，供 UI 逐条浏览与勾选。 */
async function messagesOf(node: { opencodeSessionId?: string }) {
  if (!node?.opencodeSessionId) return []
  const messages = await visibleMessages(node.opencodeSessionId)
  return messages
    .map((m) => ({
      id: m.id,
      role: m.role,
      text: visibleMessageText(m),
      reasoning: m.role === "assistant" ? m.parts.filter((part) => part.type === "reasoning" && part.text).map((part) => part.text!.trim()).join("\n") : "",
      completedAt: m.completedAt,
      finish: m.finish,
      tokens: m.role === "assistant" ? m.tokens ?? null : null,
    }))
    .filter((m) => m.text.trim() || m.reasoning.trim())
}

async function finalAssistantText(sessionId: string, fallback: string): Promise<string> {
  const messages = await visibleMessages(sessionId)
  return messages
    .filter((m) => m.role === "assistant")
    .map(visibleMessageText)
    .filter(Boolean)
    .at(-1) ?? fallback
}

/** 「详细信息」：原始对话优先，无对话时退回摘要，供 UI 展示与派生使用。 */
async function detailTextOf(nodeId: string): Promise<string> {
  const node = store.node(nodeId)
  if (!node) return ""
  const convo = await sessionTextOf(node)
  return convo || node.summaries.at(-1)?.text || ""
}

/** 构造 Portal / 派生节点使用的精简快照：摘要 + 详细信息节选。 */
async function snapshotTextOf(nodeId: string): Promise<string> {
  const node = store.node(nodeId)
  if (!node) return ""
  const summary = node.summaries.at(-1)?.text ?? ""
  const detail = (await detailTextOf(nodeId)).slice(0, 800)
  return [summary, detail].filter(Boolean).join("\n\n")
}

function linkEndpoints(link: { from: string; to: string }, into?: string) {
  if (into === link.from) return { source: link.to, target: link.from }
  if (into === link.to) return { source: link.from, target: link.to }
  return { source: link.from, target: link.to }
}

const routes: Array<{
  method: string
  pattern: RegExp
  handler: (ctx: {
    params: string[]
    req: Request
    url: URL
    body: any
  }) => Promise<Response>
}> = [
  {
    method: "GET",
    pattern: /^\/health$/,
    handler: async () => {
      const opencode = await runtime.health()
      return json({
        nodex: "ok",
        opencode: { ...opencode, supported: opencode.healthy && isOpencodeVersionSupported(opencode.version) },
        capabilities: runtime.capabilities,
      })
    },
  },
  {
    method: "GET",
    pattern: /^\/graph$/,
    handler: async ({ url }) => {
      const data = store.snapshot()
      // 归档节点（合并后）默认不进入画布，但保留在存储中可追溯
      if (url.searchParams.get("includeArchived") === "1") return json(data)
      const visible = new Set(
        data.nodes.filter((n) => n.lifecycle !== "archived").map((n) => n.id),
      )
      return json({
        nodes: data.nodes.filter((n) => visible.has(n.id)),
        links: data.links.filter((l) => visible.has(l.from) && visible.has(l.to)),
        workspaces: data.workspaces,
        members: data.members.filter((m) => visible.has(m.nodeId)),
        collaborations: (data.collaborations ?? []).filter((instance) => !instance.workspaceId || data.workspaces.some((ws) => ws.id === instance.workspaceId)),
      })
    },
  },
  {
    method: "GET",
    pattern: /^\/settings\/ai$/,
    handler: async () => {
      const saved = store.settings().ai ?? {}
      const resolved = resolveAiSettings(storeAiSettings())
      return json({
        baseUrl: saved.baseUrl ?? "",
        model: saved.model ?? "",
        systemPrompt: saved.systemPrompt ?? "",
        effectiveBaseUrl: resolved.baseUrl,
        effectiveModel: resolved.model,
        hasApiKey: Boolean(resolved.apiKey),
        apiKeyMasked: maskApiKey(resolved.apiKey),
        apiKeySource: resolved.apiKeySource,
        defaults: { baseUrl: DEFAULT_AI_BASE_URL, model: DEFAULT_AI_MODEL },
      })
    },
  },
  {
    method: "PUT",
    pattern: /^\/settings\/ai$/,
    handler: async ({ body }) => {
      const ai: AiSettings = {}
      const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : ""
      const model = typeof body?.model === "string" ? body.model.trim() : ""
      const systemPrompt = typeof body?.systemPrompt === "string" ? body.systemPrompt.trim() : ""
      if (baseUrl) ai.baseUrl = baseUrl
      if (model) ai.model = model
      if (systemPrompt) ai.systemPrompt = systemPrompt
      // apiKey 只写不读，且单独存到 secrets.json：未提交新值时保留原值，clearApiKey 显式清除。
      if (body?.clearApiKey === true) store.setAiApiKey(undefined)
      else if (typeof body?.apiKey === "string" && body.apiKey.trim()) store.setAiApiKey(body.apiKey.trim())
      store.patchSettings({ ai })
      const resolved = resolveAiSettings(storeAiSettings())
      return json({
        ok: true,
        hasApiKey: Boolean(resolved.apiKey),
        apiKeyMasked: maskApiKey(resolved.apiKey),
        apiKeySource: resolved.apiKeySource,
        effectiveModel: resolved.model,
        effectiveBaseUrl: resolved.baseUrl,
      })
    },
  },
  {
    method: "POST",
    pattern: /^\/settings\/ai\/test$/,
    handler: async () => {
      const resolved = resolveAiSettings(storeAiSettings())
      try {
        const reply = await aiChat(resolved, { prompt: "只回复两个字：正常", timeoutMs: 30000 })
        return json({ ok: true, model: resolved.model, baseUrl: resolved.baseUrl, reply: reply.slice(0, 100) })
      } catch (error) {
        return json({ ok: false, model: resolved.model, baseUrl: resolved.baseUrl, error: (error as Error).message }, 502)
      }
    },
  },
  {
    method: "GET",
    pattern: /^\/sessions$/,
    handler: async () => {
      const bindings = new Map(store.snapshot().nodes.filter((node) => node.opencodeSessionId && node.lifecycle !== "archived").map((node) => [node.opencodeSessionId, node.id]))
      const sessions = await runtime.listSessions()
      return json({ sessions: sessions.filter((session) => !session.title.startsWith("__nodex_meta__"))
        .map((session) => ({ ...session, nodeId: bindings.get(session.id) ?? null })) })
    },
  },
  {
    method: "POST",
    pattern: /^\/sessions\/([^/]+)\/attach$/,
    handler: async ({ params, body }) => {
      if (body?.categories !== undefined && (!Array.isArray(body.categories) || body.categories.some((value: unknown) => typeof value !== "string"))) {
        return json({ error: "categories 必须是字符串数组" }, 400)
      }
      const session = await runtime.getSession(params[0])
      const existing = store.snapshot().nodes.find((node) => node.opencodeSessionId === session.id && node.lifecycle !== "archived")
      if (existing) return json(existing)
      const node = store.upsertNode(newNode({ id: `node_${randomUUID().slice(0, 8)}`, title: session.title || "OpenCode 会话", opencodeSessionId: session.id,
        categories: Array.isArray(body?.categories) ? body.categories : [] }))
      if (body?.workspaceId && store.workspace(body.workspaceId)) {
        store.setMembers([...store.snapshot().members, memberOf(body.workspaceId, node.id, false)])
      }
      return json(node, 201)
    },
  },
  {
    // 原生会话 reconcile：标记图中已不存在的会话节点，并按 parentId 补齐 fork 血缘。
    method: "POST",
    pattern: /^\/sessions\/reconcile$/,
    handler: async () => {
      const nodes = store.snapshot().nodes
        .filter((node) => node.lifecycle !== "archived" && node.opencodeSessionId)
        .map((node) => ({ id: node.id, opencodeSessionId: node.opencodeSessionId! }))
      const sessions = await runtime.listSessions()
      const plan = planReconcile(nodes, sessions.map((session) => ({ id: session.id, parentId: session.parentId })))
      for (const nodeId of plan.missingNodeIds) {
        const node = store.node(nodeId)
        if (node && !node.meta?.sessionMissing) store.patchNode(nodeId, { meta: { ...node.meta, sessionMissing: true } })
      }
      for (const nodeId of plan.okNodeIds) {
        const node = store.node(nodeId)
        if (node?.meta?.sessionMissing) {
          const { sessionMissing: _drop, ...rest } = node.meta
          store.patchNode(nodeId, { meta: rest })
        }
      }
      const existing = new Set(store.snapshot().links.filter((link) => link.kind === "fork").map((link) => `${link.from}->${link.to}`))
      let linksCreated = 0
      for (const link of plan.forkLinks) {
        const key = `${link.fromNodeId}->${link.toNodeId}`
        if (existing.has(key)) continue
        store.upsertLink({ id: `link_${randomUUID().slice(0, 8)}`, kind: "fork", from: link.fromNodeId, to: link.toNodeId, directed: true, meta: { reconciled: true }, createdAt: new Date().toISOString() })
        existing.add(key)
        linksCreated += 1
      }
      return json({ missingNodeIds: plan.missingNodeIds, linksCreated, sessionCount: sessions.length })
    },
  },
  {
    method: "POST",
    pattern: /^\/nodes$/,
    handler: async ({ body }) => {
      const id = `node_${randomUUID().slice(0, 8)}`
      const content = typeof body.content === "string" ? body.content.trim() : ""
      const model = resolveModel(body.model)
      if (body.categories !== undefined && (!Array.isArray(body.categories) || body.categories.some((value: unknown) => typeof value !== "string"))) {
        return json({ error: "categories 必须是字符串数组" }, 400)
      }
      const categories: string[] = body.categories ?? []
      const joinActiveWorkspace = () => {
        if (body.workspaceId && store.workspace(body.workspaceId)) {
          store.setMembers([...store.snapshot().members, memberOf(body.workspaceId, id, false)])
        }
      }

      // 笔记本节点：纯 Markdown 草稿，不绑定运行时会话、不消耗模型。
      if (body.kind === "notebook") {
        let created = newNode({
          id,
          title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : "未命名笔记本",
          kind: "notebook",
          categories,
        })
        created.meta = { doc: typeof body.doc === "string" ? body.doc : "" }
        created = store.upsertNode(created)
        joinActiveWorkspace()
        return json(created, 201)
      }

      // 继承父节点上下文创建子节点：
      //   - inheritMode=auto（默认）：父节点不大时用原生 fork（命中暖缓存、全保真），
      //     过大时退回 seed（优先父节点摘要，避免把接近上限的前缀搬进子节点）。
      //   - fork / seed：强制指定；forkPoint：可选，从某条消息分叉（缺省到末尾）。
      //   兼容旧字段 seedFromNodeId（等价于 inheritFromNodeId + inheritMode=seed）。
      const inheritFromNodeId = typeof body.inheritFromNodeId === "string" ? body.inheritFromNodeId.trim()
        : typeof body.seedFromNodeId === "string" ? body.seedFromNodeId.trim() : ""
      const source = inheritFromNodeId ? store.node(inheritFromNodeId) : undefined
      const requestedMode = body.inheritMode === "fork" || body.inheritMode === "seed" ? body.inheritMode
        : typeof body.seedFromNodeId === "string" ? "seed" : "auto"
      // 用节点累计的 tokenCount 判定 fork / seed：不要为了决策去拉取整段父会话消息，
      // 父节点上下文一长，messagesOf 的开销会随之线性增长，新建子节点会卡很久。
      const parentTokens = source?.tokenCount ?? 0
      const inheritFork = Boolean(source?.opencodeSessionId) &&
        (requestedMode === "fork" || (requestedMode === "auto" && parentTokens > 0 && parentTokens <= inheritForkLimit()))

      let session: Awaited<ReturnType<typeof runtime.createSession>>
      if (inheritFork) {
        session = await runtime.fork(source!.opencodeSessionId!, typeof body.forkPoint === "string" ? body.forkPoint : undefined)
      } else {
        session = await runtime.createSession({
          title: body.title ?? (content ? content.slice(0, 24) : "未命名节点"),
        })
      }
      let node = newNode({
        id,
        title: body.title?.trim() || session.title || (content ? content.slice(0, 12) : "未命名节点"),
        opencodeSessionId: session.id,
        categories,
      })
      if (model) node.meta = { ...node.meta, model }
      node = store.upsertNode(node)
      joinActiveWorkspace()

      if (inheritFromNodeId && source?.opencodeSessionId) {
        if (inheritFork) {
          node = store.patchNode(node.id, { meta: { ...node.meta, forkedFrom: source.id } }) ?? node
        } else {
          // 种子正文优先取父节点摘要；只有没有摘要时才逐条读取消息（较慢，但已非默认路径）。
          const summary = source.summaries.at(-1)?.text?.trim()
          const inherited = summary ? [] : await messagesOf(source)
          if (summary || inherited.length) {
            const seedText = seedBlock("inherit", source.title, inheritedSeedBody(source, inherited))
            await runtime.seed(session.id, seedText)
            node = store.patchNode(node.id, {
              meta: { ...node.meta, seededFrom: source.id },
              tokenCount: node.tokenCount + estimate(seedText),
            }) ?? node
          }
        }
        return json(node, 201)
      }

      // 仅注入上下文种子（摘录新建对话节点）：不触发模型生成。
      if (typeof body.seed === "string" && body.seed.trim()) {
        await runtime.seed(session.id, body.seed.trim())
        // 摘录标题只是临时占位：待用户首条消息产生模型输出后，再生成 AI 标题。
        if (body.provisionalTitle) {
          node = store.patchNode(node.id, { meta: { ...node.meta, titleProvisional: true } }) ?? node
        }
        return json(node, 201)
      }

      // 带内容创建：先作为节点首条对话发送，再由 AI 总结标题与推荐分类。
      if (!content) return json(node, 201)

      // defer：立即返回，让前端分步触发「回复」与「元数据」，
      // 避免一次请求里串行两次模型调用导致的长时间白屏。
      if (body.defer) return json(node, 201)

      const graph = currentGraph()
      const routed = await routeContext({
        graph,
        activeNodeIds: [node.id],
        hardLoadActive: false,
        query: content,
        tokenBudget: Number(body.tokenBudget ?? 32_000),
        fullTextOf,
      })
      const context = renderContext(routed)
      // 路由上下文走请求级 system：用户文本 part 保持干净，不落注入标记。
      const result = await runtime.prompt({ sessionId: session.id, text: content, system: context || undefined, model })
      const reply = await finalAssistantText(session.id, result.text)
      node = store.patchNode(node.id, { tokenCount: node.tokenCount + estimate(context ? `${context}\n\n${content}` : content) }) ?? node

      let generated: Awaited<ReturnType<typeof generateMetadata>> = null
      try {
        generated = await generateMetadata(runtime, `${content}\n\n${reply}`, { model })
      } catch {
        generated = null
      }
      if (generated) {
        const patch: Record<string, unknown> = {}
        if (generated.title) patch.title = generated.title
        if (generated.categories.length) patch.categories = [...new Set([...node.categories, ...generated.categories])]
        if (generated.tags?.length) patch.tags = generated.tags
        if (generated.summary) patch.summaries = appendSummary(node, generated.summary, "ai", runtime.id)
        node = store.patchNode(node.id, patch) ?? node
      }
      return json({ node, generated, reply }, 201)
    },
  },
  {
    method: "POST",
    pattern: /^\/nodes\/([^/]+)\/abort$/,
    handler: async ({ params }) => {
      const node = store.node(params[0])
      if (!node) return json({ error: "节点不存在" }, 404)
      if (!node.opencodeSessionId) return json({ error: "节点未绑定运行时会话" }, 400)
      return json({ aborted: await runtime.abort(node.opencodeSessionId) })
    },
  },
  {
    method: "GET",
    pattern: /^\/nodes\/([^/]+)\/collaboration-results$/,
    handler: async ({ params }) => {
      const instance = collaborationForMain(params[0])
      if (!instance) {
        const parent = store.collaborations().find((item) => item.slots.some((slot) => slot.key !== item.mainKey && slot.nodeId === params[0]))
        return json({ mainNodeId: parent?.slots.find((slot) => slot.key === parent.mainKey)?.nodeId ?? null, workers: [] })
      }
      const workers = await Promise.all(instance.slots.filter((slot) => slot.key !== instance.mainKey).map(async (slot) => {
        const node = store.node(slot.nodeId!)
        if (!node?.opencodeSessionId) return null
        const messages = await messagesOf(node)
        const last = messages.filter((message) => message.role === "assistant" && message.text.trim() && message.finish === "stop").at(-1)
        return { nodeId: node.id, title: node.title, role: slot.label, preview: last?.text.slice(0, 320) ?? "" }
      }))
      return json({ mainNodeId: params[0], workers: workers.filter(Boolean) })
    },
  },
  {
    method: "POST",
    pattern: /^\/nodes\/([^/]+)\/prompt\/stream$/,
    handler: async ({ params, body }) => {
      const node = store.node(params[0])
      if (!node) return json({ error: "节点不存在" }, 404)
      if (!node.opencodeSessionId) return json({ error: "节点未绑定运行时会话" }, 400)
      if (store.collaborations().some((item) => runningCollaborations.has(item.id) && item.slots.some((slot) => slot.nodeId === node.id))) {
        return json({ error: "协作已在运行" }, 409)
      }
      const command = typeof body?.command === "string" ? body.command : null
      const compose = command === "compose"
      if (command !== null) {
        if (!/^[a-zA-Z][\w.:-]*$/.test(command) || typeof body.arguments !== "string" || (!compose && !(await runtime.listCommands()).some((item) => item.name === command))) {
          return json({ error: "命令不可用" }, 400)
        }
      }
      const collaboration = compose ? collaborationForMain(node.id) : undefined
      if (compose && !collaboration) return json({ error: "当前节点没有可用的协作模板" }, 409)
      if (!command && !String(body.text ?? "").trim()) return json({ error: "请填写消息" }, 400)
      if (collaboration) {
        const invalid = validateCollaboration(collaboration)
        if (invalid) return json({ error: invalid }, 409)
      }

      const routed = collaboration || command ? null : await routeContext({
        graph: currentGraph(), activeNodeIds: [node.id], hardLoadActive: false, query: body.text ?? "",
        tokenBudget: Number(body.tokenBudget ?? 32_000), fullTextOf,
      })
      const context = routed ? renderContext(routed) : ""
      const text = command ? `/${command}${body.arguments ? ` ${body.arguments}` : ""}` : body.text ?? ""
      const model = resolveModel(body.model, node)
      const encoder = new TextEncoder()
      const send = (controller: ReadableStreamDefaultController, payload: unknown) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)) } catch { /* The browser disconnected. */ }
      }

      return new Response(
        new ReadableStream({
          start(controller) {
            void (async () => {
              let unsubscribe = () => {}
              // SSE 心跳：等待用户回答问题或模型长时间思考时，定期发注释帧，
              // 避免中间代理 / 隧道按空闲超时把长连接截断。
              const heartbeat = setInterval(() => {
                try { controller.enqueue(encoder.encode(": ping\n\n")) } catch { /* 连接已关闭 */ }
              }, 15000)
              try {
                if (routed) send(controller, {
                  type: "context", context: {
                    usedTokens: routed.usedTokens, dropped: routed.dropped.map((c) => c.nodeId),
                    tiers: routed.chunks.map((c) => ({ nodeId: c.nodeId, tier: c.tier })),
                  },
                })
                try {
                  unsubscribe = await runtime.subscribe((event) => {
                    if (event.sessionId !== node.opencodeSessionId) return
                    if (event.type === "question") {
                      send(controller, { type: "question", request: event.request })
                      return
                    }
                    if (event.type === "tool") {
                      send(controller, {
                        type: "tool", name: event.name, status: event.status,
                        error: event.error ? event.error.slice(0, 180) : undefined,
                      })
                      return
                    }
                    if (event.type === "thinking-delta") {
                      send(controller, { type: "thinking", text: event.text })
                      return
                    }
                    if (event.type === "text-delta") {
                      send(controller, { type: "text", text: event.text })
                    }
                  })
                } catch {
                  unsubscribe = () => {}
                }

                let reply: string
                if (collaboration) {
                  const result = await runCollaboration(
                    collaboration,
                    String(body.arguments ?? "").trim(),
                    body.model,
                    (event) => send(controller, event),
                  )
                  reply = result.reply
                } else if (command) {
                  const result = await runtime.command({ sessionId: node.opencodeSessionId!, name: command, arguments: body.arguments, model, agent: nodeAgent(node), variant: nodeVariant(node) })
                  reply = result.text
                  store.patchNode(node.id, { tokenCount: node.tokenCount + estimate(text) })
                } else {
                  const result = await runtime.prompt({ sessionId: node.opencodeSessionId!, text, system: context || undefined, model, agent: nodeAgent(node), variant: nodeVariant(node) })
                  reply = await finalAssistantText(node.opencodeSessionId!, result.text)
                  store.patchNode(node.id, { tokenCount: node.tokenCount + estimate(context ? `${context}\n\n${text}` : text) })
                }
                send(controller, { type: "done", reply })
              } catch (error) {
                const failure: Error & { results?: unknown[] } = error instanceof Error ? error : new Error(String(error))
                send(controller, {
                  type: "error",
                  error: failure.message,
                  results: failure.results ?? [],
                })
              } finally {
                clearInterval(heartbeat)
                unsubscribe()
                try { controller.close() } catch { /* The browser disconnected. */ }
              }
            })()
          },
        }),
        {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "access-control-allow-origin": "*",
          },
        },
      )
    },
  },
  {
    method: "POST",
    pattern: /^\/nodes\/([^/]+)\/prompt$/,
    handler: async ({ params, body }) => {
      const node = store.node(params[0])
      if (!node) return json({ error: "节点不存在" }, 404)
      if (!node.opencodeSessionId) return json({ error: "节点未绑定运行时会话" }, 400)
      if (store.collaborations().some((item) => runningCollaborations.has(item.id) && item.slots.some((slot) => slot.nodeId === node.id))) {
        return json({ error: "协作已在运行" }, 409)
      }
      const compose = body?.command === "compose"
      const collaboration = compose ? collaborationForMain(node.id) : undefined
      if (compose && !collaboration) return json({ error: "当前节点没有可用的协作模板" }, 409)
      if (collaboration) {
        const task = String(body.arguments ?? "").trim()
        const invalid = validateCollaboration(collaboration)
        if (invalid) return json({ error: invalid }, 409)
        const result = await runCollaboration(collaboration, task, body.model)
        return json({ reply: result.reply, results: result.results, mainNodeId: result.mainNodeId })
      }

      const graph = currentGraph()
      const routed = await routeContext({
        graph,
        activeNodeIds: [node.id],
        hardLoadActive: false,
        query: body.text ?? "",
        tokenBudget: Number(body.tokenBudget ?? 32_000),
        fullTextOf,
      })

      const context = renderContext(routed)
      const text = body.text ?? ""
      const model = resolveModel(body.model, node)
      const result = await runtime.prompt({ sessionId: node.opencodeSessionId, text, system: context || undefined, model, agent: nodeAgent(node), variant: nodeVariant(node) })
      const reply = await finalAssistantText(node.opencodeSessionId, result.text)

      store.patchNode(node.id, { tokenCount: node.tokenCount + estimate(context ? `${context}\n\n${text}` : text) })
      return json({
        reply,
        context: {
          usedTokens: routed.usedTokens,
          dropped: routed.dropped.map((c) => c.nodeId),
          tiers: routed.chunks.map((c) => ({ nodeId: c.nodeId, tier: c.tier })),
          systemPrompt: routed.systemPrompt,
        },
      })
    },
  },
  {
    method: "DELETE",
    pattern: /^\/nodes\/([^/]+)$/,
    handler: async ({ params }) => {
      const node = store.node(params[0])
      if (!node) return json({ error: "节点不存在" }, 404)
      if (store.collaborations().some((item) => runningCollaborations.has(item.id) && item.slots.some((slot) => slot.nodeId === node.id))) {
        return json({ error: "协作运行中，不能删除节点" }, 409)
      }
      if (node.opencodeSessionId) await runtime.deleteSession(node.opencodeSessionId)
      return json({ deleted: store.deleteNode(node.id) })
    },
  },
  {
    method: "POST",
    pattern: /^\/nodes\/([^/]+)\/fork$/,
    handler: async ({ params, body }) => {
      const node = store.node(params[0])
      if (!node?.opencodeSessionId) return json({ error: "节点未绑定运行时会话" }, 400)
      if (!runtime.capabilities.fork) return json({ error: "运行时不支持 fork" }, 400)
      const forked = await runtime.fork(node.opencodeSessionId, body?.messageId)
      const id = `node_${randomUUID().slice(0, 8)}`
      const created = newNode({
        id,
        title: `${node.title} (分支)`,
        opencodeSessionId: forked.id,
        categories: node.categories,
      })
      created.meta = { ...created.meta, ...(node.meta.model ? { model: node.meta.model } : {}), ...(node.meta.agent ? { agent: node.meta.agent } : {}) }
      store.upsertNode(created)
      const members = store.snapshot().members
      store.setMembers([...members, ...members.filter((member) => member.nodeId === node.id).map((member) => ({ ...member, nodeId: created.id, addedAt: new Date().toISOString() }))])
      store.upsertLink({
        id: `link_${randomUUID().slice(0, 8)}`,
        kind: "fork",
        from: node.id,
        to: id,
        directed: true,
        meta: {},
        createdAt: new Date().toISOString(),
      })
      return json(created, 201)
    },
  },
  {
    // 撤销上一步：把会话回退到最后一条用户消息之前（OpenCode 原生 revert）
    method: "POST",
    pattern: /^\/nodes\/([^/]+)\/undo$/,
    handler: async ({ params }) => {
      const node = store.node(params[0])
      if (!node?.opencodeSessionId) return json({ error: "节点未绑定运行时会话" }, 400)
      const messages = await visibleMessages(node.opencodeSessionId)
      const lastUser = [...messages].reverse().find((m) => m.role === "user")
      if (!lastUser) return json({ error: "没有可撤销的用户消息" }, 400)
      const text = visibleMessageText(lastUser)
      await runtime.revert(node.opencodeSessionId, lastUser.id)
      return json({ undone: true, messageId: lastUser.id, text })
    },
  },
  {
    // 取消撤销：恢复被 revert 的消息
    method: "POST",
    pattern: /^\/nodes\/([^/]+)\/unrevert$/,
    handler: async ({ params }) => {
      const node = store.node(params[0])
      if (!node?.opencodeSessionId) return json({ error: "节点未绑定运行时会话" }, 400)
      await runtime.unrevert(node.opencodeSessionId)
      return json({ unreverted: true })
    },
  },
  {
    /**
     * 勾选上下文导出新节点（灵活 fork）。
     *  - mode=context（默认）：新建会话，用 noReply 注入选中内容作为种子，不触发模型生成。
     *  - mode=fork：仅在恰好选中一条消息时，走 OpenCode 原生 fork（真正的分支）。
     */
    method: "POST",
    pattern: /^\/nodes\/([^/]+)\/export$/,
    handler: async ({ params, body }) => {
      const node = store.node(params[0])
      if (!node?.opencodeSessionId) return json({ error: "节点未绑定运行时会话" }, 400)

      const selectedIds: string[] = Array.isArray(body?.messageIds)
        ? body.messageIds.filter((x: unknown): x is string => typeof x === "string")
        : []
      if (selectedIds.length === 0) return json({ error: "请先勾选要导出的上下文" }, 400)

      const all = await messagesOf(node)
      const picked = all.filter((m) => selectedIds.includes(m.id))
      if (picked.length === 0) return json({ error: "选中的消息不存在" }, 400)

      const mode = body?.mode === "fork" ? "fork" : "context"
      const id = `node_${randomUUID().slice(0, 8)}`
      const now = new Date().toISOString()
      let sessionId: string
      let title = body?.title?.trim() || `${node.title} · 导出`
      let exportedBy: "fork" | "context"

      if (mode === "fork" && picked.length === 1) {
        const forked = await runtime.fork(node.opencodeSessionId, picked[0].id)
        sessionId = forked.id
        title = body?.title?.trim() || `${node.title} (分支)`
        exportedBy = "fork"
      } else {
        const session = await runtime.createSession({ title })
        const body = [
          ...picked.map((m) => `[${m.role === "user" ? "我" : "AI"}] ${m.text}`),
          "（以上为背景资料，请在此基础上继续。）",
        ].join("\n\n")
        await runtime.seed(session.id, seedBlock("export", node.title, body))
        sessionId = session.id
        exportedBy = "context"
      }

      const created = newNode({
        id,
        title,
        opencodeSessionId: sessionId,
        kind: node.kind,
        categories: node.categories,
        tags: node.tags,
      })
      created.meta = {
        ...created.meta,
        exportedFrom: node.id,
        exportedBy,
        exportedMessageIds: picked.map((m) => m.id),
      }
      created.tokenCount = picked.reduce((sum, m) => sum + estimate(m.text), 0)
      store.upsertNode(created)

      if (body?.workspaceId && store.workspace(body.workspaceId)) {
        store.setMembers([...store.snapshot().members, memberOf(body.workspaceId, id, false)])
      }

      const link = {
        id: `link_${randomUUID().slice(0, 8)}`,
        kind: "fork" as const,
        from: node.id,
        to: id,
        directed: true,
        meta: { exportedBy, messageIds: picked.map((m) => m.id) },
        createdAt: now,
      }
      store.upsertLink(link)

      return json({ node: created, link, exportedBy, count: picked.length }, 201)
    },
  },
  {
    method: "POST",
    pattern: /^\/nodes\/([^/]+)\/compact$/,
    handler: async ({ params }) => {
      const node = store.node(params[0])
      if (!node?.opencodeSessionId) return json({ error: "节点未绑定运行时会话" }, 400)
      if (!runtime.capabilities.summarize) return json({ error: "运行时不支持压缩" }, 400)
      if (store.collaborations().some((item) => runningCollaborations.has(item.id) && item.slots.some((slot) => slot.nodeId === node.id))) {
        return json({ error: "协作已在运行" }, 409)
      }
      const model = resolveModel(undefined, node) ?? await runtime.defaultModel()
      if (!model) return json({ error: "请选择模型后再压缩会话" }, 400)
      await runtime.compact(node.opencodeSessionId, model)
      return json({ compacted: true })
    },
  },
  {
    method: "POST",
    pattern: /^\/nodes\/([^/]+)\/summarize$/,
    handler: async ({ params }) => {
      const node = store.node(params[0])
      if (!node?.opencodeSessionId) return json({ error: "节点未绑定运行时会话" }, 400)
      const text = await runtime.summarize(node.opencodeSessionId)
      if (!text) return json({ error: "摘要未生成（可能需要配置模型）" }, 400)
      const version = node.summaries.length + 1
      const updated = store.patchNode(node.id, {
        summaries: [
          ...node.summaries,
          { text, version, createdAt: new Date().toISOString() },
        ],
      })
      return json(updated)
    },
  },
  {
    method: "POST",
    pattern: /^\/links$/,
    handler: async ({ body }) => {
      if (!store.node(body.from) || !store.node(body.to)) {
        return json({ error: "from/to 节点不存在" }, 404)
      }
      const kind = body.kind ?? "reference"

      // Portal 必须有快照，否则路由时会忽略该链路。
      // 未显式提供时，自动从目标节点的摘要与详细信息生成。
      let snapshotText: string | undefined = body.snapshot
      if (kind === "portal" && !snapshotText) {
        snapshotText = await snapshotTextOf(body.to)
        if (!snapshotText) {
          return json({ error: "目标节点暂无摘要或对话内容，无法生成 portal 快照" }, 400)
        }
      }

      const link = {
        id: `link_${randomUUID().slice(0, 8)}`,
        kind,
        from: body.from,
        to: body.to,
        directed: body.directed ?? true,
        snapshot: snapshotText
          ? { text: snapshotText, version: 1, source: "ai" as const, createdAt: new Date().toISOString() }
          : undefined,
        meta: body.meta ?? {},
        createdAt: new Date().toISOString(),
      }
      store.upsertLink(link)
      return json(link, 201)
    },
  },
  {
    method: "GET",
    pattern: /^\/nodes\/([^/]+)\/context$/,
    handler: async ({ params, url }) => {
      const node = store.node(params[0])
      if (!node) return json({ error: "节点不存在" }, 404)

      const graph = currentGraph()
      let routed: Awaited<ReturnType<typeof routeContext>>
      try {
        routed = await routeContext({
          graph,
          activeNodeIds: [node.id],
          hardLoadActive: false,
          query: url.searchParams.get("q") ?? "",
          tokenBudget: Number(url.searchParams.get("budget") ?? 32_000),
          fullTextOf,
        })
      } catch (error) {
        // 运行时读取失败时返回降级结果，避免整段会话被错误替换。
        return json({
          activeNode: { id: node.id, title: node.title },
          workspaces: workspacesOf(graph, node.id),
          overlapNodeIds: [],
          systemPrompt: "",
          variables: {},
          usedTokens: 0,
          chunks: [],
          dropped: [],
          error: (error as Error).message,
        })
      }

      // 只返回可解释的路由结果，不泄露未激活节点的正文
      return json({
        activeNode: { id: node.id, title: node.title },
        workspaces: workspacesOf(graph, node.id),
        overlapNodeIds: routed.overlapNodeIds,
        systemPrompt: routed.systemPrompt,
        variables: routed.variables,
        usedTokens: routed.usedTokens,
        chunks: routed.chunks.map((c) => ({
          nodeId: c.nodeId,
          tier: c.tier,
          tokens: c.tokens,
          trusted: c.trusted,
          source: c.source,
          preview: c.text.slice(0, 120),
        })),
        dropped: routed.dropped.map((c) => ({ nodeId: c.nodeId, tier: c.tier })),
      })
    },
  },
  {
    method: "GET",
    pattern: /^\/nodes\/([^/]+)$/,
    handler: async ({ params }) => {
      const node = store.node(params[0])
      if (!node) return json({ error: "节点不存在" }, 404)
      const graph = currentGraph()
      // 运行时偶发失败（会话被中断 / 上游 500）不应让整个节点读取失败，
      // 否则前端会把整段对话替换成错误、看不到历史上下文。
      let messages: Awaited<ReturnType<typeof messagesOf>> = []
      let messagesError: string | undefined
      try { messages = await messagesOf(node) } catch (error) { messagesError = (error as Error).message }
      let detail = node.summaries.at(-1)?.text ?? ""
      try { detail = await detailTextOf(node.id) } catch { /* 回退到摘要 */ }
      return json({
        node,
        workspaces: workspacesOf(graph, node.id).map((id) => {
          const ws = store.workspace(id)
          return { id, name: ws?.name ?? id, color: ws?.color ?? null }
        }),
        links: store.snapshot().links.filter((l) => l.from === node.id || l.to === node.id),
        summary: node.summaries.at(-1)?.text ?? "",
        detail,
        messages,
        ...(messagesError ? { messagesError } : {}),
      })
    },
  },
  {
    method: "PATCH",
    pattern: /^\/nodes\/([^/]+)$/,
    handler: async ({ params, body }) => {
      const node = store.node(params[0])
      if (!node) return json({ error: "节点不存在" }, 404)

      const patch: Record<string, unknown> = {}
      if (typeof body.title === "string") {
        const title = body.title.trim()
        if (!title) return json({ error: "标题不能为空" }, 400)
        patch.title = title
      }
      if (body.categories !== undefined) {
        if (!Array.isArray(body.categories) || body.categories.some((value: unknown) => typeof value !== "string")) {
          return json({ error: "categories 必须是字符串数组" }, 400)
        }
        patch.categories = body.categories
        patch.category = body.categories[0] ?? ""
      } else if (typeof body.category === "string") patch.category = body.category.trim()
      if (Array.isArray(body.tags)) {
        patch.tags = body.tags
          .filter((t: unknown): t is string => typeof t === "string")
          .map((t: string) => t.trim())
          .filter(Boolean)
      }
      if (body.iconColor !== undefined) {
        if (body.iconColor === null || body.iconColor === "") {
          const meta = { ...node.meta }
          delete meta.iconColor
          patch.meta = meta
        } else if (typeof body.iconColor === "string" && /^#[0-9a-fA-F]{6}$/.test(body.iconColor.trim())) {
          patch.meta = { ...node.meta, iconColor: body.iconColor.trim() }
        } else {
          return json({ error: "iconColor 必须是 #RRGGBB 格式" }, 400)
        }
      }

      if (Object.keys(patch).length === 0) {
        return json({ error: "没有可更新的字段（支持 title / categories / category / tags / iconColor）" }, 400)
      }
      const updated = store.patchNode(node.id, patch)
      return json(updated)
    },
  },
  {
    method: "POST",
    pattern: /^\/layouts$/,
    handler: async ({ body }) => {
      const viewId = typeof body?.viewId === "string" && body.viewId.trim() ? body.viewId.trim() : "2d-canvas"
      const positions = body?.positions
      if (!positions || typeof positions !== "object" || Array.isArray(positions)) {
        return json({ error: "positions 必须是 { nodeId: {x,y} } 对象" }, 400)
      }
      let updated = 0
      if (body?.clear === true) {
        for (const node of store.snapshot().nodes) {
          if (!node.layouts?.[viewId]) continue
          const layouts = { ...node.layouts }
          delete layouts[viewId]
          store.patchNode(node.id, { layouts })
          updated++
        }
        return json({ updated, viewId, cleared: true })
      }
      for (const [id, value] of Object.entries(positions as Record<string, unknown>)) {
        const point = value as { x?: unknown; y?: unknown }
        const x = Number(point?.x)
        const y = Number(point?.y)
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        const node = store.node(id)
        if (!node) continue
        store.patchNode(id, {
          layouts: {
            ...node.layouts,
            [viewId]: { viewId, position: { x, y, z: 0 }, pinned: true },
          },
        })
        updated++
      }
      return json({ updated, viewId })
    },
  },
  {
    method: "POST",
    pattern: /^\/nodes\/([^/]+)\/metadata$/,
    handler: async ({ params, body }) => {
      const node = store.node(params[0])
      if (!node) return json({ error: "节点不存在" }, 404)

      const content = (await sessionTextOf(node)) || node.summaries.at(-1)?.text || ""
      if (!content.trim()) {
        return json({ error: "节点暂无对话内容，无法生成元数据" }, 400)
      }

      const hint = {
        currentTitle: node.title,
        currentCategory: node.categories.join("、"),
      }
      // 优先用 NodeX 直连模型（与笔记本摘要同一套配置），失败再退回 OpenCode。
      let meta = await generateMetadataWithAi(resolveAiSettings(storeAiSettings()), content, hint).catch(() => null)
      if (!meta) {
        meta = await generateMetadata(runtime, content, { ...hint, model: resolveModel(body?.model, node) })
      }
      if (!meta) return json({ error: "模型未返回可解析的元数据" }, 502)

      const apply = body?.apply !== false // 默认直接应用
      if (!apply) return json({ generated: meta, applied: false })

      // 模型偶尔漏给 title（只回 categories/summary）。标题仍是占位值（或摘录的临时标题）时
      // 用摘要兜底，否则节点会一直显示「未命名节点」/ 摘录短句。
      const derivedTitle = deriveTitleFrom(meta.summary || content)
      const canRetitle = isPlaceholderNodeTitle(node.title) || node.meta?.titleProvisional === true
      const nextTitle = meta.title || (canRetitle ? derivedTitle : "")
      const patch: Record<string, unknown> = {
        title: nextTitle || node.title,
        categories: [...new Set([...node.categories, ...meta.categories])],
        tags: meta.tags,
        // 生成过一次正式标题后清除「临时标题」标记，之后不再覆盖用户/模型命名。
        meta: { ...node.meta, titleProvisional: false },
      }
      if (meta.summary) {
        patch.summaries = appendSummary(node, meta.summary, "ai", runtime.id)
      }
      const updated = store.patchNode(node.id, patch)
      return json({ generated: meta, applied: true, node: updated })
    },
  },
  {
    method: "POST",
    pattern: /^\/nodes\/([^/]+)\/notebook-summary$/,
    handler: async ({ params }) => {
      const node = store.node(params[0])
      if (!node) return json({ error: "节点不存在" }, 404)
      if (node.kind !== "notebook") return json({ error: "只有笔记本可以生成摘要" }, 400)

      const doc = typeof node.meta?.doc === "string" ? node.meta.doc.trim() : ""
      if (!doc) return json({ error: "笔记本暂无内容，无法生成摘要" }, 400)

      const resolved = resolveAiSettings(storeAiSettings())
      const meta = await generateMetadataWithAi(resolved, doc, {
        currentTitle: node.title,
      })
      if (!meta) return json({ error: "模型未返回可解析的摘要" }, 502)

      const patch: Record<string, unknown> = {}
      if (meta.summary) patch.summaries = appendSummary(node, meta.summary, "ai", resolved.model)
      const unnamed = ["", "未命名笔记本", "草稿本", "摘录本", "笔记本"].includes((node.title ?? "").trim())
      if (unnamed && meta.title) patch.title = meta.title
      const updated = store.patchNode(node.id, patch)
      return json({ summary: meta.summary, title: updated.title, node: updated })
    },
  },
  {
    // 通用文本改写（文件编辑器划选菜单用），不依赖节点
    method: "POST",
    pattern: /^\/ai\/rewrite$/,
    handler: async ({ body }) => {
      const text = typeof body?.text === "string" ? body.text.trim() : ""
      if (!text) return json({ error: "没有可改写的文本" }, 400)
      const instruction = typeof body?.instruction === "string" && body.instruction.trim()
        ? body.instruction.trim()
        : "在保持原意的前提下润色，使表达更清晰"
      const resolved = resolveAiSettings(storeAiSettings())
      const out = await aiChat(resolved, {
        system: "你是文本编辑助手。严格按照用户的改写指令处理给定文本，只输出改写后的文本，不要解释，不要使用代码块，不要添加额外说明。",
        prompt: `改写指令：${instruction}\n\n需要改写的文本：\n${text}`,
        timeoutMs: 120000,
      })
      return json({ text: out.trim(), model: resolved.model })
    },
  },
  {
    // 用 AI 按指令改写笔记本中选中的文本
    method: "POST",
    pattern: /^\/nodes\/([^/]+)\/notebook-rewrite$/,
    handler: async ({ params, body }) => {
      const node = store.node(params[0])
      if (!node) return json({ error: "节点不存在" }, 404)
      if (node.kind !== "notebook") return json({ error: "只有笔记本可以改写文本" }, 400)
      const text = typeof body?.text === "string" ? body.text.trim() : ""
      if (!text) return json({ error: "没有可改写的文本" }, 400)
      const instruction = typeof body?.instruction === "string" && body.instruction.trim()
        ? body.instruction.trim()
        : "在保持原意的前提下润色，使表达更清晰"
      const resolved = resolveAiSettings(storeAiSettings())
      const out = await aiChat(resolved, {
        system: "你是文本编辑助手。严格按照用户的改写指令处理给定文本，只输出改写后的文本，不要解释，不要使用代码块，不要添加额外说明。",
        prompt: `改写指令：${instruction}\n\n需要改写的文本：\n${text}`,
        timeoutMs: 120000,
      })
      return json({ text: out.trim(), model: resolved.model })
    },
  },
  {
    method: "POST",
    pattern: /^\/nodes\/([^/]+)\/summary$/,
    handler: async ({ params, body }) => {
      const node = store.node(params[0])
      if (!node) return json({ error: "节点不存在" }, 404)
      const text = typeof body?.text === "string" ? body.text.trim() : ""
      if (!text) return json({ error: "摘要不能为空" }, 400)
      const updated = store.patchNode(node.id, {
        summaries: appendSummary(node, text, "manual"),
      })
      return json(updated)
    },
  },
  {
    method: "DELETE",
    pattern: /^\/links\/([^/]+)$/,
    handler: async ({ params }) => {
      const before = store.snapshot().links.length
      const links = store.snapshot().links.filter((l) => l.id !== params[0])
      if (links.length === before) return json({ error: "连接不存在" }, 404)
      store.setLinks(links)
      return json({ deleted: true, id: params[0] })
    },
  },
  {
    method: "POST",
    pattern: /^\/links\/([^/]+)\/merge$/,
    handler: async ({ params, body }) => {
      const link = store.snapshot().links.find((l) => l.id === params[0])
      if (!link) return json({ error: "连接不存在" }, 404)

      // into 指定保留哪一个节点；未指定则保留 link.to
      const { source, target } = linkEndpoints(link, body?.into)
      if (source === target) return json({ error: "合并方向无效" }, 400)

      const sourceNode = store.node(source)
      const targetNode = store.node(target)
      if (!sourceNode || !targetNode) return json({ error: "节点不存在" }, 404)

      const [sourceText, targetText] = await Promise.all([
        detailTextOf(source),
        detailTextOf(target),
      ])

      // 生成合并摘要；AI 不可用时退回拼接，保证合并总能完成
      let mergedText = ""
      let mergedBy = "fallback"
      try {
        const raw = await runtime.complete({
          prompt:
            `把以下两份内容合并为一段不超过 200 字的摘要，保留关键结论与差异，不要罗列原始句子。\n\n` +
            `【${sourceNode.title}】\n${sourceText.slice(0, 3000)}\n\n` +
            `【${targetNode.title}】\n${targetText.slice(0, 3000)}`,
          system: "你是知识图谱的摘要合并器。只输出合并后的摘要正文，不要标题与解释。",
        })
        if (raw.trim()) {
          mergedText = raw.trim()
          mergedBy = "ai"
        }
      } catch {
        // 忽略，走 fallback
      }
      if (!mergedText) {
        mergedText = [sourceText, targetText]
          .map((t) => t.trim().slice(0, 600))
          .filter(Boolean)
          .join("\n\n---\n\n")
      }

      const targetUpdated = store.patchNode(target, {
        summaries: appendSummary(targetNode, mergedText, mergedBy === "ai" ? "ai" : "compress"),
        meta: {
          ...targetNode.meta,
          mergedFrom: [...new Set([...(targetNode.meta.mergedFrom as string[] ?? []), source])],
        },
      })

      // 源节点归档而非删除，保留来源可追溯；释放其运行时会话
      store.patchNode(source, {
        lifecycle: "archived",
        meta: { ...sourceNode.meta, mergedInto: target },
      })
      if (sourceNode.opencodeSessionId) {
        await runtime.deleteSession(sourceNode.opencodeSessionId).catch(() => false)
      }
      store.upsertLink({ ...link, kind: "merge", from: source, to: target, directed: true })

      return json({
        mergedInto: target,
        archived: source,
        mergedBy,
        summary: mergedText,
        target: targetUpdated,
      })
    },
  },
  {
    method: "POST",
    pattern: /^\/links\/([^/]+)\/spawn$/,
    handler: async ({ params }) => {
      const link = store.snapshot().links.find((l) => l.id === params[0])
      if (!link) return json({ error: "连接不存在" }, 404)

      const a = store.node(link.from)
      const b = store.node(link.to)
      if (!a || !b) return json({ error: "连接的节点不存在" }, 404)

      // 新建空节点：不带入任何原始对话，只把两侧的摘要与详细信息
      // 作为 Portal 快照挂上，供三层路由按需注入。
      const id = `node_${randomUUID().slice(0, 8)}`
      const session = await runtime.createSession({ title: `由「${a.title}」「${b.title}」派生` })
      const created = newNode({
        id,
        title: `由「${a.title}」「${b.title}」派生`,
        opencodeSessionId: session.id,
      })
      store.upsertNode(created)

      const now = new Date().toISOString()
      const createdLinks = []
      for (const origin of [a, b]) {
        const snapshot = await snapshotTextOf(origin.id)
        const l = {
          id: `link_${randomUUID().slice(0, 8)}`,
          kind: "portal" as const,
          from: created.id,
          to: origin.id,
          directed: true,
          snapshot: { text: snapshot, version: 1, source: "ai" as const, createdAt: now },
          meta: { spawnedFrom: link.id },
          createdAt: now,
        }
        store.upsertLink(l)
        createdLinks.push(l)
      }

      return json({ node: created, links: createdLinks }, 201)
    },
  },
  {
    method: "GET",
    pattern: /^\/models$/,
    handler: async () => {
      const models = await runtime.listModels()
       return json({ models, default: resolveModel(undefined) ?? await runtime.defaultModel() ?? null })
    },
  },
  {
    method: "GET",
    pattern: /^\/agents$/,
    handler: async () => {
      const [agents, configured] = await Promise.all([runtime.listAgents(), runtime.defaultAgent()])
      return json({ agents, default: agents.find((item) => item.name === configured)?.name ?? (agents.some((item) => item.name === "build") ? "build" : agents[0]?.name ?? null) })
    },
  },
  {
    method: "GET",
    pattern: /^\/commands$/,
    handler: async () => json({ commands: await runtime.listCommands() }),
  },
  {
    method: "PUT",
    pattern: /^\/nodes\/([^/]+)\/session-settings$/,
    handler: async ({ params, body }) => {
      const node = store.node(params[0])
      if (!node) return json({ error: "节点不存在" }, 404)
      if (!node.opencodeSessionId) return json({ error: "节点未绑定运行时会话" }, 400)
      let model: ModelRef | null | undefined
      let agent: string | null | undefined
      let variant: string | null | undefined
      let models: Awaited<ReturnType<typeof runtime.listModels>> | undefined
      if (Object.hasOwn(body ?? {}, "model")) {
        if (body.model === null) model = null
        else {
          model = sanitizeModel(body.model)
          if (!model) return json({ error: "模型格式无效" }, 400)
          models = await runtime.listModels()
          if (!models.some((item) => item.providerID === model!.providerID && item.modelID === model!.modelID)) return json({ error: "模型不可用" }, 400)
        }
      }
      if (Object.hasOwn(body ?? {}, "agent")) {
        if (body.agent === null) agent = null
        else {
          const agents = await runtime.listAgents()
          if (typeof body.agent !== "string" || !agents.some((item) => item.name === body.agent)) return json({ error: "agent 不可用" }, 400)
          agent = body.agent
        }
      }
      if (Object.hasOwn(body ?? {}, "variant")) {
        if (body.variant === null || body.variant === "") variant = null
        else if (typeof body.variant !== "string") return json({ error: "思考强度无效" }, 400)
        else {
          // 校验变体属于最终生效模型，避免切换到不支持该强度的模型后残留。
          // 模型未声明 variants 时允许标准档位，让窗口能不依赖 OpenCode 配置自行设置强度。
          const effective = model ?? sanitizeModel(store.node(node.id)!.meta?.model) ?? resolveModel(undefined, node)
          if (effective) {
            models = models ?? await runtime.listModels()
            const info = models.find((item) => item.providerID === effective.providerID && item.modelID === effective.modelID)
            const allowed = info?.variants?.length ? info.variants : STANDARD_THINK_LEVELS
            if (!allowed.includes(body.variant)) return json({ error: "该模型不支持此思考强度" }, 400)
          }
          variant = body.variant
        }
      }
      if (!Object.hasOwn(body ?? {}, "model") && !Object.hasOwn(body ?? {}, "agent") && !Object.hasOwn(body ?? {}, "variant")) {
        return json({ error: "请提供 model、agent 或 variant" }, 400)
      }
      const meta = { ...store.node(node.id)!.meta }
      if (model === null) delete meta.model
      else if (model) meta.model = model
      if (agent === null) delete meta.agent
      else if (agent) meta.agent = agent
      if (variant === null) delete meta.variant
      else if (variant) meta.variant = variant
      // 切换模型时，若新模型不支持原思考强度，则清空以免残留。
      if (model && meta.variant) {
        const info = (models ?? await runtime.listModels()).find((item) => item.providerID === model!.providerID && item.modelID === model!.modelID)
        const allowed = info?.variants?.length ? info.variants : STANDARD_THINK_LEVELS
        if (!allowed.includes(meta.variant)) delete meta.variant
      }
      return json(store.patchNode(node.id, { meta }))
    },
  },
  {
    method: "POST",
    pattern: /^\/nodes\/([^/]+)\/questions\/([^/]+)\/(reply|reject)$/,
    handler: async ({ params, body }) => {
      const node = store.node(params[0])
      if (!node?.opencodeSessionId) return json({ error: "节点会话不存在" }, 404)
      const pendingQuestions = await runtime.listQuestions()
      const request = pendingQuestions.find((item) => item.id === params[1] && item.sessionID === node.opencodeSessionId)
      if (!request) {
        // 问题属于别的会话 → 404；问题已不存在 → 410（已失效）。
        if (pendingQuestions.some((item) => item.id === params[1])) return json({ error: "该节点没有此待回答问题" }, 404)
        return json({ error: "该问题已失效（会话可能已中断）", gone: true }, 410)
      }
      // 会话中断 / 问题超时后再提交会失败：用 410 告知前端该问题已不可答，
      // 前端据此清理面板并恢复输入，而不是让整个窗口卡在 500。
      const goneOrError = async (error: unknown) => {
        let gone = false
        try { gone = !(await runtime.listQuestions()).some((item) => item.id === request.id) } catch { /* 保留原错误 */ }
        return json({ error: gone ? "该问题已失效（会话可能已中断）" : `提交回答失败：${(error as Error).message}`, gone }, gone ? 410 : 502)
      }
      if (params[2] === "reject") {
        try { await runtime.rejectQuestion(request.id) } catch (error) { return goneOrError(error) }
        return json({ rejected: true })
      }
      const answers = body?.answers
      if (!Array.isArray(answers) || answers.length !== request.questions.length || answers.some((answer: unknown) =>
        !Array.isArray(answer) || !answer.length || answer.some((value) => typeof value !== "string" || !value.trim() || value.length > 8000))) {
        return json({ error: "请为每个问题提交选项或文本回答" }, 400)
      }
      for (const [index, question] of request.questions.entries()) {
        if (!question.multiple && answers[index].length !== 1) return json({ error: "单选问题只能回答一项" }, 400)
        if (question.custom === false && answers[index].some((value: string) => !question.options.some((option) => option.label === value))) {
          return json({ error: "该问题不支持自定义回答" }, 400)
        }
      }
      try { await runtime.replyQuestion(request.id, answers) } catch (error) { return goneOrError(error) }
      return json({ replied: true })
    },
  },
  {
    method: "GET",
    pattern: /^\/runtime\/status$/,
    handler: async () => {
      await refreshSessionStatuses()
      const graph = store.snapshot()
      let pending: Awaited<ReturnType<typeof runtime.listQuestions>> | null = null
      try { pending = await runtime.listQuestions() } catch { /* Leave previously shown questions intact on transient failure. */ }
      const questions = new Map<string, NonNullable<typeof pending>>()
      for (const item of pending ?? []) {
        const list = questions.get(item.sessionID) ?? []
        list.push(item)
        questions.set(item.sessionID, list)
      }
      const sessions: Record<string, { status: "busy" | "idle"; updatedAt: number }> = statusAvailable ? Object.fromEntries(runtimeStatuses.entries()) : {}
      for (const sessionId of questions.keys()) delete sessions[sessionId]
      const stale: Record<string, number> = {}
      if (pending) {
        await Promise.all(graph.nodes.filter((node) => node.opencodeSessionId && sessions[node.opencodeSessionId] && !questions.has(node.opencodeSessionId)).map(async (node) => {
          try {
            const last = (await visibleMessages(node.opencodeSessionId!)).at(-1)
            if (last?.role === "assistant" && last.finish === "stop" && last.completedAt && Date.now() - last.completedAt > 10000) {
              stale[node.opencodeSessionId!] = last.completedAt
              delete sessions[node.opencodeSessionId!]
            }
          } catch { /* Keep the runtime's busy status when history cannot be checked. */ }
        }))
      }
      return json({
        available: statusAvailable,
        sessions,
        stale,
        questionsAvailable: pending !== null,
        questions: Object.fromEntries(graph.nodes.filter((node) => node.opencodeSessionId && questions.has(node.opencodeSessionId)).map((node) => [node.id, questions.get(node.opencodeSessionId!) ])),
        activity: Object.fromEntries(graph.nodes.map((node) => [node.id, node.lastActiveAt ?? null])),
        updatedAt: Date.now(),
      })
    },
  },
  {
    method: "GET",
    pattern: /^\/collaborations$/,
    handler: async () => json({ collaborations: store.collaborations() }),
  },
  {
    method: "POST",
    pattern: /^\/collaborations$/,
    handler: async ({ body }) => {
      let shape
      try { shape = collaborationLayout(body?.kind as CollaborationKind, (body?.config ?? {}) as CollaborationConfig) }
      catch (error) { return json({ error: (error as Error).message }, 400) }
      if (body?.workspaceId && !store.workspace(body.workspaceId)) return json({ error: "页面不存在" }, 404)
      const selected = Array.isArray(body?.nodeIds) ? body.nodeIds : []
      if (selected.length > shape.slots.length || new Set(selected).size !== selected.length) return json({ error: "已有节点数量或选择无效" }, 400)
      const occupied = new Set(store.collaborations().flatMap((item) => item.slots.map((slot) => slot.nodeId)))
      for (const id of selected) {
        const node = store.node(id)
        if (!node || node.kind !== "session" || node.lifecycle !== "active" || !node.opencodeSessionId) return json({ error: `无效会话节点: ${id}` }, 400)
        if (occupied.has(id)) return json({ error: `节点已属于其他协作: ${id}` }, 409)
      }
      const now = new Date().toISOString()
      const instance: CollaborationInstance = {
        id: `collab_${randomUUID().slice(0, 8)}`,
        name: typeof body?.name === "string" && body.name.trim() ? body.name.trim() : ({ "three-ministries": "三省六部", brainstorm: "头脑风暴", debate: "辩论赛" }[body.kind as CollaborationKind]),
        kind: body.kind, config: shape.config, workspaceId: body.workspaceId,
        slots: shape.slots.map((slot, index) => ({ ...slot, ...(selected[index] ? { nodeId: selected[index] } : {}) })),
        links: shape.links, mainKey: shape.mainKey,
        ownedNodeIds: [], instructions: {}, createdAt: now, updatedAt: now,
      }
      try {
        for (const slot of instance.slots) {
          if (!slot.nodeId) {
            const node = await createCollaborationNode(slot.label, instance.workspaceId)
            slot.nodeId = node.id
            instance.ownedNodeIds.push(node.id)
          } else if (instance.workspaceId && !store.snapshot().members.some((m) => m.workspaceId === instance.workspaceId && m.nodeId === slot.nodeId)) {
            store.setMembers([...store.snapshot().members, memberOf(instance.workspaceId, slot.nodeId, false)])
          }
        }
        syncCollaborationLinks(instance)
        store.upsertCollaboration(instance)
        return json(instance, 201)
      } catch (error) {
        // Preserve created sessions for recovery rather than silently orphaning them.
        try { syncCollaborationLinks(instance) } catch { /* Keep the instance for recovery. */ }
        store.upsertCollaboration(instance)
        return json({ error: `创建部分完成: ${(error as Error).message}`, collaboration: instance }, 502)
      }
    },
  },
  {
    method: "PUT",
    pattern: /^\/collaborations\/([^/]+)$/,
    handler: async ({ params, body }) => {
      const instance = store.collaborations().find((item) => item.id === params[0])
      if (!instance) return json({ error: "协作实例不存在" }, 404)
      if (runningCollaborations.has(instance.id)) return json({ error: "协作运行中，不能修改结构" }, 409)
      let shape
      try { shape = collaborationLayout(instance.kind, (body?.config ?? instance.config) as CollaborationConfig) }
      catch (error) { return json({ error: (error as Error).message }, 400) }
      const bindings = body?.bindings && typeof body.bindings === "object" && !Array.isArray(body.bindings) ? body.bindings : {}
      const requested = shape.slots.map((slot) => Object.hasOwn(bindings, slot.key) ? bindings[slot.key] : instance.slots.find((old) => old.key === slot.key)?.nodeId)
      if (requested.some((id) => id != null && (typeof id !== "string" || !id.trim()))) return json({ error: "无效槽位绑定" }, 400)
      const ids = requested.filter(Boolean)
      if (new Set(ids).size !== ids.length) return json({ error: "同一节点不能占用多个槽位" }, 400)
      const occupied = new Set(store.collaborations().filter((item) => item.id !== instance.id).flatMap((item) => item.slots.map((slot) => slot.nodeId)))
      for (const id of ids) {
        const node = store.node(id)
        if (!node || node.kind !== "session" || node.lifecycle !== "active" || !node.opencodeSessionId) return json({ error: `无效会话节点: ${id}` }, 400)
        if (occupied.has(id)) return json({ error: `节点已属于其他协作: ${id}` }, 409)
      }
      const removed = instance.slots.filter((old) => !shape.slots.some((slot) => slot.key === old.key) || (Object.hasOwn(bindings, old.key) && bindings[old.key] !== old.nodeId))
      instance.slots = shape.slots.map((slot, index) => ({ ...slot, ...(requested[index] ? { nodeId: requested[index] } : {}) }))
      instance.links = shape.links
      instance.mainKey = shape.mainKey
      instance.config = shape.config
      const instructions = body?.instructions && typeof body.instructions === "object" ? body.instructions : instance.instructions ?? {}
      instance.instructions = Object.fromEntries(shape.slots.map((slot) => [slot.key, typeof instructions[slot.key] === "string" ? instructions[slot.key].trim().slice(0, 4000) : ""]))
      try {
        for (const slot of instance.slots) {
          if (!slot.nodeId) {
            const node = await createCollaborationNode(slot.label, instance.workspaceId)
            slot.nodeId = node.id
            instance.ownedNodeIds.push(node.id)
          } else if (instance.workspaceId && !store.snapshot().members.some((m) => m.workspaceId === instance.workspaceId && m.nodeId === slot.nodeId)) {
            store.setMembers([...store.snapshot().members, memberOf(instance.workspaceId, slot.nodeId, false)])
          }
        }
        instance.updatedAt = new Date().toISOString()
        store.upsertCollaboration(instance)
        syncCollaborationLinks(instance)
      } catch (error) {
        store.upsertCollaboration(instance)
        return json({ error: `更新部分完成: ${(error as Error).message}`, collaboration: instance }, 502)
      }
      for (const old of removed) {
        if (!old.nodeId || !instance.ownedNodeIds.includes(old.nodeId) || instance.slots.some((slot) => slot.nodeId === old.nodeId)) continue
        const node = store.node(old.nodeId)
        instance.ownedNodeIds = instance.ownedNodeIds.filter((id) => id !== old.nodeId)
        if (!node || node.tokenCount !== 0 || store.snapshot().links.some((link) => link.from === node.id || link.to === node.id)) continue
        try {
          if ((await messagesOf(node)).length) continue
          if (node.opencodeSessionId) await runtime.deleteSession(node.opencodeSessionId)
          store.deleteNode(node.id)
        } catch { /* Keep the unbound session for recovery. */ }
      }
      return json(store.upsertCollaboration(instance))
    },
  },
  {
    method: "POST",
    pattern: /^\/collaborations\/([^/]+)\/start$/,
    handler: async ({ params, body }) => {
      const instance = store.collaborations().find((item) => item.id === params[0])
      if (!instance) return json({ error: "协作实例不存在" }, 404)
      const task = typeof body?.task === "string" ? body.task.trim() : ""
      if (!task) return json({ error: "请填写本次协作任务" }, 400)
      const invalid = validateCollaboration(instance)
      if (invalid) return json({ error: invalid }, 409)
      try {
        return json(await runCollaboration(instance, task, body?.model))
      } catch (error) {
        return json({ error: (error as Error).message, results: (error as Error & { results?: unknown }).results ?? [], mainNodeId: instance.slots.find((slot) => slot.key === instance.mainKey)?.nodeId }, 502)
      }
    },
  },
  {
    method: "DELETE",
    pattern: /^\/collaborations\/([^/]+)$/,
    handler: async ({ params }) => {
      const instance = store.collaborations().find((item) => item.id === params[0])
      if (!instance) return json({ error: "协作实例不存在" }, 404)
      if (runningCollaborations.has(instance.id)) return json({ error: "协作运行中，不能删除" }, 409)
      store.setLinks(store.snapshot().links.filter((link) => link.meta?.collaborationId !== instance.id))
      for (const id of instance.ownedNodeIds) {
        const node = store.node(id)
        if (!node || node.tokenCount !== 0 || store.snapshot().links.some((link) => link.from === id || link.to === id)) continue
        try {
          if ((await messagesOf(node)).length) continue
          if (node.opencodeSessionId) await runtime.deleteSession(node.opencodeSessionId)
          store.deleteNode(node.id)
        } catch { /* Preserve the session if cleanup fails. */ }
      }
      store.deleteCollaboration(instance.id)
      return json({ deleted: true })
    },
  },
  {
    method: "GET",
    pattern: /^\/templates$/,
    handler: async () => json({ templates: availableTemplates() }),
  },
  {
    method: "POST",
    pattern: /^\/templates$/,
    handler: async ({ body }) => {
      const name = typeof body?.name === "string" ? body.name.trim() : ""
      const slots = Array.isArray(body?.slots) ? body.slots : []
      const links = Array.isArray(body?.links) ? body.links : []
      if (!name) return json({ error: "模板名称不能为空" }, 400)
      if (slots.length === 0) return json({ error: "模板至少需要一个 agent 槽位" }, 400)
      const normalizedSlots = slots
        .filter((slot: any) => typeof slot?.key === "string")
        .map((slot: any) => ({
          key: slot.key,
          label: typeof slot.label === "string" ? slot.label : slot.key,
          x: Number.isFinite(slot.x) ? slot.x : 0,
          y: Number.isFinite(slot.y) ? slot.y : 0,
          ...(typeof slot.nodeId === "string" ? { nodeId: slot.nodeId } : {}),
        }))
      const keys = new Set(normalizedSlots.map((slot: LayoutTemplateSlot) => slot.key))
      const normalizedLinks = links
        .filter((link: any) => keys.has(link?.from) && keys.has(link?.to))
        .map((link: any) => ({
          from: link.from,
          to: link.to,
          kind: link.kind ?? "reference",
          directed: link.directed !== false,
        }))
      const now = new Date().toISOString()
      const template: LayoutTemplate = {
        id: `tpl_${randomUUID().slice(0, 8)}`,
        name,
        description: typeof body.description === "string" ? body.description.trim() : "",
        slots: normalizedSlots,
        links: normalizedLinks,
        createdAt: now,
        updatedAt: now,
      }
      store.upsertTemplate(template)
      return json(template, 201)
    },
  },
  {
    method: "DELETE",
    pattern: /^\/templates\/([^/]+)$/,
    handler: async ({ params }) => {
      const template = availableTemplates().find((item) => item.id === params[0])
      if (!template) return json({ error: "模板不存在" }, 404)
      if (template.builtin) return json({ error: "内置模板不可删除" }, 400)
      return json({ deleted: store.deleteTemplate(params[0]), id: params[0] })
    },
  },
  {
    method: "GET",
    pattern: /^\/settings$/,
    handler: async () => {
      const settings = store.settings()
      return json({
        ...settings,
        contextLimit: settings.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
        autoCompact: settings.autoCompact === true,
        defaultModel: resolveModel(undefined) ?? null,
      })
    },
  },
  {
    method: "PUT",
    pattern: /^\/settings$/,
    handler: async ({ body }) => {
      const patch: Record<string, unknown> = {}
      if (body?.defaultModel === null) patch.defaultModel = undefined
      else {
        const model = sanitizeModel(body?.defaultModel)
        if (body?.defaultModel !== undefined && !model) {
          return json({ error: "defaultModel 需要 providerID 与 modelID" }, 400)
        }
        if (model) patch.defaultModel = model
      }
      if (body?.filesRoot === null) patch.filesRoot = undefined
      else if (typeof body?.filesRoot === "string") patch.filesRoot = body.filesRoot.trim() || undefined
      if (body?.contextLimit === null) patch.contextLimit = undefined
      else if (body?.contextLimit !== undefined) {
        const limit = Number(body.contextLimit)
        if (!Number.isFinite(limit) || limit < 1000) return json({ error: "contextLimit 需为不小于 1000 的数字" }, 400)
        patch.contextLimit = Math.round(limit)
      }
      if (body?.autoCompact !== undefined) patch.autoCompact = body.autoCompact === true

      const saved = store.patchSettings(patch)
      return json({
        ...saved,
        contextLimit: saved.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
        autoCompact: saved.autoCompact === true,
        defaultModel: resolveModel(undefined) ?? null,
      })
    },
  },
  {
    // 保存笔记本草稿（Markdown 原文）
    method: "PUT",
    pattern: /^\/nodes\/([^/]+)\/doc$/,
    handler: async ({ params, body }) => {
      const node = store.node(params[0])
      if (!node) return json({ error: "节点不存在" }, 404)
      if (node.kind !== "notebook") return json({ error: "该节点不是笔记本" }, 400)
      const doc = typeof body?.doc === "string" ? body.doc : ""
      const updated = store.patchNode(node.id, { meta: { ...node.meta, doc } })
      return json(updated)
    },
  },
  {
    // 摘录一段内容追加到笔记本：保留原始 Markdown，并在末尾插入来源标记
    method: "POST",
    pattern: /^\/nodes\/([^/]+)\/excerpt$/,
    handler: async ({ params, body }) => {
      const node = store.node(params[0])
      if (!node) return json({ error: "节点不存在" }, 404)
      if (node.kind !== "notebook") return json({ error: "该节点不是笔记本" }, 400)
      const text = typeof body?.text === "string" ? body.text.trim() : ""
      if (!text) return json({ error: "摘录内容不能为空" }, 400)

      const fromTitle = typeof body?.fromTitle === "string" ? body.fromTitle.trim() : ""
      const fromNodeId = typeof body?.fromNodeId === "string" ? body.fromNodeId.trim() : ""
      const messageId = typeof body?.messageId === "string" ? body.messageId.trim() : ""
      const offset = Number.isFinite(body?.offset) ? Math.max(0, Math.round(body.offset)) : 0
      const marker = fromNodeId
        ? `\n<span class="nodex-excerpt-src" data-nodex-node="${escapeAttr(fromNodeId)}" data-nodex-mid="${escapeAttr(messageId)}" data-nodex-offset="${offset}" data-nodex-from="${escapeAttr(fromTitle)}"></span>\n`
        : ""
      const doc = typeof node.meta?.doc === "string" ? node.meta.doc : ""
      const next = `${doc}${doc.trim() ? "\n\n" : ""}${text}${marker}`
      const updated = store.patchNode(node.id, { meta: { ...node.meta, doc: next } })
      return json({ node: updated, appended: text.length, linked: Boolean(fromNodeId) })
    },
  },
  {
    // 列出该节点会话中产出/访问过的文件
    method: "GET",
    pattern: /^\/nodes\/([^/]+)\/files$/,
    handler: async ({ params }) => {
      const node = store.node(params[0])
      if (!node) return json({ error: "节点不存在" }, 404)
      const root = filesRoot()
      const messages = node.opencodeSessionId ? await visibleMessages(node.opencodeSessionId) : []
      return json({ root, files: collectNodeFiles(messages, root) })
    },
  },
  {
    // 读取文件用于预览（限制在允许的根目录内）
    method: "GET",
    pattern: /^\/file$/,
    handler: async ({ url }) => {
      const path = url.searchParams.get("path")
      if (!path) return json({ error: "缺少 path 参数" }, 400)
      const roots = allowedRoots()
      // 命中第一个允许根就返回其结果：文件存在但不能预览（压缩包 / 二进制）时
      // 也要把它自己的说明返回，而不是被后续根的「越界」错误盖掉。
      const root = roots.find((candidate) => isWithinRoot(path, candidate))
      if (!root) return json({ error: "路径超出允许预览的根目录，已拒绝读取（仅显示路径）", roots }, 400)
      const view = readFileForPreview(path, root)
      if ("error" in view) return json({ ...view, root }, 400)
      return json({ ...view, root })
    },
  },
  {
    // 保存文本文件（在线编辑）：限制在允许根内、仅文本、限制大小。
    method: "PUT",
    pattern: /^\/file$/,
    handler: async ({ body }) => {
      const path = typeof body?.path === "string" ? body.path : ""
      if (!path) return json({ error: "缺少 path 参数" }, 400)
      const result = writeFileForEdit(path, body?.content, allowedRoots())
      if (result.error) return json(result, 400)
      return json({ ...result, saved: true })
    },
  },
  {
    // 本地目录浏览：列出目录内容（限制在允许的根目录内）
    method: "GET",
    pattern: /^\/fs\/list$/,
    handler: async ({ url }) => {
      const roots = allowedRoots()
      const requested = url.searchParams.get("path")?.trim()
      const listing = listDirectory(requested || roots[0], roots)
      if ("error" in listing) return json({ ...listing, roots }, 400)
      return json({ ...listing, roots })
    },
  },
  {
    // 本工作区引用过的文件（用于目录浏览的「本工作区」筛选）
    method: "GET",
    pattern: /^\/fs\/workspace\/([^/]+)\/files$/,
    handler: async ({ params }) => {
      const ws = store.workspace(params[0])
      if (!ws) return json({ error: "工作区不存在" }, 404)
      const root = filesRoot()
      const graph = store.snapshot()
      const nodeIds = new Set(graph.members.filter((member) => member.workspaceId === ws.id).map((member) => member.nodeId))
      const nodes = graph.nodes.filter((node) => nodeIds.has(node.id) && node.opencodeSessionId)
      const merged = new Map<string, { file: ReturnType<typeof collectNodeFiles>[number]; nodeId: string; nodeTitle: string }>()
      await Promise.all(nodes.map(async (node) => {
        try {
          const messages = await visibleMessages(node.opencodeSessionId!)
          for (const file of collectNodeFiles(messages, root)) {
            const prev = merged.get(file.path)
            if (prev) {
              if (file.direction === "output") prev.file = { ...prev.file, direction: "output" }
            } else {
              merged.set(file.path, { file, nodeId: node.id, nodeTitle: node.title })
            }
          }
        } catch {
          /* 单个会话读取失败不影响其它节点 */
        }
      }))
      const files = [...merged.values()].sort((a, b) => Number(b.file.exists) - Number(a.file.exists) || a.file.rel.localeCompare(b.file.rel))
      return json({ root, dir: ws.dir ?? null, files })
    },
  },
  {
    // 下载文件（限制在允许的根目录内）
    method: "GET",
    pattern: /^\/fs\/download$/,
    handler: async ({ url }) => {
      const path = url.searchParams.get("path")
      if (!path) return json({ error: "缺少 path 参数" }, 400)
      const raw = readRawFile(path, allowedRoots())
      if ("error" in raw) return json({ error: raw.error }, 400)
      return new Response(raw.buffer, {
        headers: {
          "content-type": raw.mime,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(raw.name)}`,
        },
      })
    },
  },
  {
    method: "POST",
    pattern: /^\/fs\/mkdir$/,
    handler: async ({ body }) => {
      const result = makeDirectory(body?.dir, body?.name, allowedRoots())
      if (result.error) return json(result, 400)
      return json(result, 201)
    },
  },
  {
    method: "POST",
    pattern: /^\/fs\/create$/,
    handler: async ({ body }) => {
      const result = createTextFile(body?.dir, body?.name, allowedRoots())
      if (result.error) return json(result, 400)
      return json(result, 201)
    },
  },
  {
    method: "POST",
    pattern: /^\/fs\/rename$/,
    handler: async ({ body }) => {
      const result = renameEntry(body?.path, body?.name, allowedRoots())
      if (result.error) return json(result, 400)
      if (result.from && result.to && result.from !== result.to) pushFsUndo({ kind: "rename", from: result.from, to: result.to })
      return json(result)
    },
  },
  {
    method: "POST",
    pattern: /^\/fs\/copy$/,
    handler: async ({ body }) => {
      const result = copyEntry(body?.from, body?.toDir, allowedRoots(), body?.overwrite === true)
      if (result.error) return json(result, result.exists ? 409 : 400)
      return json(result, 201)
    },
  },
  {
    method: "POST",
    pattern: /^\/fs\/move$/,
    handler: async ({ body }) => {
      const result = moveEntry(body?.from, body?.toDir, allowedRoots(), body?.overwrite === true)
      if (result.error) return json(result, result.exists ? 409 : 400)
      if (result.from && result.to && result.from !== result.to) pushFsUndo({ kind: "move", from: result.from, to: result.to })
      return json(result)
    },
  },
  {
    method: "POST",
    pattern: /^\/fs\/delete$/,
    handler: async ({ body }) => {
      const result = trashEntry(body?.path, allowedRoots(), fsTrashDir())
      if (result.error) return json(result, 400)
      if (result.from && result.trashPath) pushFsUndo({ kind: "trash", from: result.from, to: result.trashPath })
      return json({ ...result, undoable: true })
    },
  },
  {
    method: "POST",
    pattern: /^\/fs\/undo$/,
    handler: async () => {
      const entry = fsUndoStack.pop()
      if (!entry) return json({ error: "没有可撤回的文件操作" }, 400)
      let result: ReturnType<typeof restoreFromTrash>
      if (entry.kind === "trash") result = restoreFromTrash(entry.to, entry.from)
      else result = moveEntry(entry.to, dirname(entry.from), allowedRoots(), true)
      if (result.error) {
        fsUndoStack.push(entry)
        return json(result, 400)
      }
      return json({ undone: entry.kind, path: entry.from })
    },
  },
  {
    method: "POST",
    pattern: /^\/workspaces$/,
    handler: async ({ body }) => {
      const origin =
        body?.origin && Number.isFinite(body.origin.x) && Number.isFinite(body.origin.y)
          ? { x: body.origin.x, y: body.origin.y }
          : undefined
      const ws = newWorkspace({
        id: `ws_${randomUUID().slice(0, 8)}`,
        name: body.name ?? "新工作区",
        systemPrompt: body.systemPrompt,
        color: body.color,
        origin,
        dir: typeof body?.dir === "string" && body.dir.trim() ? resolve(body.dir.trim()) : undefined,
      })
      store.upsertWorkspace(ws)
      return json(ws, 201)
    },
  },
  {
    method: "PATCH",
    pattern: /^\/workspaces\/([^/]+)$/,
    handler: async ({ params, body }) => {
      const ws = store.workspace(params[0])
      if (!ws) return json({ error: "工作区不存在" }, 404)
      const patch: Record<string, unknown> = {}
      if (typeof body?.name === "string" && body.name.trim()) patch.name = body.name.trim()
      if (typeof body?.color === "string") patch.color = body.color
      if (typeof body?.systemPrompt === "string") patch.systemPrompt = body.systemPrompt
      if (body?.origin && Number.isFinite(body.origin.x) && Number.isFinite(body.origin.y)) {
        patch.origin = { x: body.origin.x, y: body.origin.y }
      }
      if (body?.dir === null) patch.dir = undefined
      else if (typeof body?.dir === "string") patch.dir = body.dir.trim() ? resolve(body.dir.trim()) : undefined
      if (Object.keys(patch).length === 0) {
        return json({ error: "没有可更新的字段（支持 name / color / systemPrompt / origin / dir）" }, 400)
      }
      const updated = store.upsertWorkspace({ ...ws, ...patch, updatedAt: new Date().toISOString() })
      return json(updated)
    },
  },
  {
    method: "DELETE",
    pattern: /^\/workspaces\/([^/]+)$/,
    handler: async ({ params }) => {
      if (!store.workspace(params[0])) return json({ error: "工作区不存在" }, 404)
      for (const item of store.collaborations().filter((instance) => instance.workspaceId === params[0])) {
        store.upsertCollaboration({ ...item, workspaceId: undefined })
      }
      return json({ deleted: store.deleteWorkspace(params[0]), id: params[0] })
    },
  },
  {
    /**
     * 合并工作区：把 :id 的成员并入 into，然后删除 :id。
     * 节点与链路都保留，只做归属合并；跨区连线因此天然成立。
     */
    method: "POST",
    pattern: /^\/workspaces\/([^/]+)\/merge$/,
    handler: async ({ params, body }) => {
      const source = store.workspace(params[0])
      const into = store.workspace(body?.into)
      if (!source || !into) return json({ error: "工作区不存在" }, 404)
      if (source.id === into.id) return json({ error: "不能合并到自身" }, 400)

      const graph = currentGraph()
      for (const nodeId of membersOf(graph, source.id)) {
        joinWorkspace(graph, into.id, nodeId, new Date().toISOString())
      }
      store.setMembers(graph.members)
      for (const item of store.collaborations().filter((instance) => instance.workspaceId === source.id)) {
        store.upsertCollaboration({ ...item, workspaceId: into.id })
      }
      store.deleteWorkspace(source.id)

      return json({
        into: store.workspace(into.id),
        members: membersOf(currentGraph(), into.id),
        mergedFrom: source.id,
      })
    },
  },
  {
    method: "POST",
    pattern: /^\/workspaces\/([^/]+)\/members$/,
    handler: async ({ params, body }) => {
      const ws = store.workspace(params[0])
      if (!ws) return json({ error: "工作区不存在" }, 404)
      if (!store.node(body.nodeId)) return json({ error: "节点不存在" }, 404)

      const graph = currentGraph()
      const action = body.action === "leave" ? leaveWorkspace : joinWorkspace
      action(graph, ws.id, body.nodeId, new Date().toISOString())
      store.setMembers(graph.members)
      return json({
        members: membersOf(graph, ws.id),
        workspacesOfNode: workspacesOf(graph, body.nodeId),
      })
    },
  },
  {
    method: "GET",
    pattern: /^\/workspaces\/([^/]+)\/members$/,
    handler: async ({ params }) => {
      const graph = currentGraph()
      if (!store.workspace(params[0])) return json({ error: "工作区不存在" }, 404)
      return json({ members: membersOf(graph, params[0]) })
    },
  },
]

const server = Bun.serve({
  port: PORT,
  // Prompt streams may wait longer than Bun's 10s default while the model starts.
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      })
    }

    for (const route of routes) {
      if (route.method !== req.method) continue
      const match = route.pattern.exec(url.pathname)
      if (!match) continue
      let body: any = undefined
      if (req.method !== "GET") {
        try {
          body = await req.json()
        } catch {
          body = {}
        }
      }
      try {
        const res = await route.handler({ params: match.slice(1), req, url, body })
        res.headers.set("access-control-allow-origin", "*")
        return res
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ error: message }, 500)
      }
    }
    return json({ error: "not found", path: url.pathname }, 404)
  },
})
export { server }

function estimate(text: string) {
  return Math.ceil((text?.length ?? 0) / 3)
}

console.log(`[nodex] API 监听 http://127.0.0.1:${server.port}`)
console.log(`[nodex] OpenCode 运行时: ${BASE_URL}`)
console.log(`[nodex] 图谱存储: ${defaultStorePath()}`)

void runtime.health().then((opencode) => {
  if (opencode.healthy && !isOpencodeVersionSupported(opencode.version)) {
    console.warn(`[nodex] 警告: OpenCode ${opencode.version} 不在支持区间 ${OPENCODE_SUPPORTED_RANGE.min} ~ ${OPENCODE_SUPPORTED_RANGE.maxExclusive}(不含)，行为可能异常`)
  }
}).catch(() => {})
