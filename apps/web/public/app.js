// NodeX 2D 图谱画布
//
// 几何计算全部来自 graph-layout.js（纯函数、可单测）。
// 本文件只负责状态、渲染与交互。
//
// 数据原则：
//   - 节点位置是视图缓存，不是权威状态；拖动会锁定该节点(pinned)。
//   - 工作区是覆盖层，与节点多对多，可交叠。
//   - 圈内节点共享上下文；圈外节点严格隔离。
//   - 标题/标签既可由 AI 生成，也可手动修改。

import {
  anchorPanel,
  computeFit,
  computeGhosts as computeGhostsPure,
  isOnPage as memberOnPage,
  hitTestLink,
  linkMidpoint,
  nodeRadius,
  pointInPolygon,
  relax,
  seedLayout,
  standardizeLayout,
  toScreen,
  toWorld,
  zoomedCamera,
  ZOOM_LIMITS,
} from "/graph-layout.js"
import { marked } from "/vendor/marked.js"
import DOMPurify from "/vendor/dompurify.js"
import katex from "/vendor/katex/dist/katex.mjs"
import { slashChoices, tuiCommand } from "/tui-commands.js"
import { recentPrompts, navigatePromptHistory } from "/prompt-history.js"
import { canDrainQueue, abortedTailMessageId } from "/runtime-status.js"
import { classifySendFailure } from "/send-recovery.js"
import { selectedMessageRange } from "/message-range.js"

const API = "/api"
// 宿主标识：VS Code 插件以 ?host=vscode 内嵌时隐藏文件侧栏与文件预览（由编辑器提供）。
const HOST = (() => {
  try { return new URLSearchParams(location.search).get("host") || window.__NODEX_HOST__ || "" } catch { return "" }
})()
const IS_VSCODE_HOST = HOST === "vscode"
const app = document.getElementById("app")
const canvas = document.getElementById("canvas")
const ctx = canvas.getContext("2d")
const canvasMenu = document.getElementById("canvasMenu")
const deleteNodeDialog = document.getElementById("deleteNodeDialog")
const confirmDialog = document.getElementById("confirmDialog")
const lassoWorkspaceDialog = document.getElementById("lassoWorkspaceDialog")
const statusEl = document.getElementById("status")
const panel = document.getElementById("inspector")
const panelBody = document.getElementById("inspectorBody")
const notebookWindows = new Map()
const notebookTemplate = document.getElementById("notebookViewerTemplate")
const contextWindows = new Map()
const contextTemplate = document.getElementById("contextViewerTemplate")
const fileWindows = new Map()
const fileTemplate = document.getElementById("fileViewerTemplate")
let windowLayer = 9
let tiledWindowPositions = null
let tileOrder = []
let tileLayout = null
let tileDividers = []
let tileMode = "grid"
let tileActiveViewer = null
// 台前调度侧栏比例：主区宽度占比与各侧栏项高度占比（可拖动分隔条调整）。
let tileDock = { widthRatio: 0.3, itemRatios: [] }
const linkMenuEl = document.getElementById("linkMenu")
const nodeHoverInfo = document.getElementById("nodeHoverInfo")
const zoomLabel = document.getElementById("zoomLabel")

const DEFAULT_VIEW_OPTIONS = { outputOnly: true, showInput: false, showThinking: false, expandThinking: false }
function loadViewOptions() {
  try { return { ...DEFAULT_VIEW_OPTIONS, ...JSON.parse(localStorage.getItem("nodex.viewOptions") || "{}") } }
  catch { return { ...DEFAULT_VIEW_OPTIONS } }
}
function saveViewOptions() {
  localStorage.setItem("nodex.viewOptions", JSON.stringify(state.viewOptions))
}

const state = {
  graph: { nodes: [], links: [], workspaces: [], members: [] },
  nodesById: new Map(),
  positions: new Map(),
  anchors: new Map(),
  activeWs: null,    // 当前页面（workspace id）；null = 全部
  ghosts: [],        // 跨页连线在页边界的幽灵节点
  pinned: new Set(),
  camera: { x: 0, y: 0, zoom: 1 },
  drag: null,
  pan: null,
  lassoArmed: false,
  lasso: null,
  region: null,       // { points: world polygon, nodeIds }
  regionDrag: null,
  rightClick: null,
  connect: null,     // { from, x, y, targetId } 双击节点后跟随鼠标的连线
  hoverLink: null,
  hoverNode: null,
  hoverPosition: null,
  hoverGhost: null,
  selectedLink: null, // 连线浮动菜单当前指向的连线
  selection: null,   // { type: "node" | "link", id }
  panelDetached: false,
  needFit: true,
  models: [],        // 运行时可用模型
  model: null,       // 当前主模型 { providerID, modelID }
  agents: [],        // 运行时可选主 agent
  defaultAgent: null,
  commands: [],      // OpenCode 当前配置的会话命令
  commandFetchAt: 0,
  selText: "",       // 最近一次划选摘录文本
  selFrom: null,     // 摘录来源节点标题
  selViewer: null,   // 摘录所在的会话节点
  runtimeStatus: new Map(),
  runtimeStatusAvailable: false,
  activeLinks: new Set(),
  templates: [],
  collaborations: [],
  contextLimit: 300000, // 上下文用量上限（tokens），来自 /settings
  autoCompact: false,   // 达到上限时自动 /compact，来自 /settings
  viewOptions: loadViewOptions(),
}

let savedPositions = new Map()
try {
  savedPositions = new Map(Object.entries(JSON.parse(localStorage.getItem("nodex.pinnedPositions") || "{}"))
    .filter(([, p]) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
    .map(([id, p]) => [id, { x: p.x, y: p.y }]))
} catch { /* Ignore invalid browser-local layout data. */ }

function savePinnedPositions() {
  localStorage.setItem("nodex.pinnedPositions", JSON.stringify(Object.fromEntries(savedPositions)))
  persistLayoutsSoon()
}

// 把本地固定布局同步到服务端，换浏览器/清缓存后仍能恢复「标准化」等结果。
let persistLayoutTimer = null
function persistLayoutsSoon(clear = false) {
  if (persistLayoutTimer) clearTimeout(persistLayoutTimer)
  persistLayoutTimer = setTimeout(() => {
    persistLayoutTimer = null
    const positions = clear ? {} : Object.fromEntries(savedPositions)
    void api("/layouts", { method: "POST", body: JSON.stringify({ positions, clear }) }).catch(() => {})
  }, 600)
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const viewport = () => ({ w: window.innerWidth, h: window.innerHeight })

// ---------------- 页面视图 / 窗口会话持久化 ----------------
const CAMERA_STORE_KEY = "nodex.cameraByPage"
const WINDOW_SESSION_KEY = "nodex.windowSession"

function pageKey(wsId = state.activeWs) { return wsId || "__all__" }

function loadCameraStore() {
  try { return JSON.parse(localStorage.getItem(CAMERA_STORE_KEY) || "{}") } catch { return {} }
}

function saveCameraForPage(wsId = state.activeWs) {
  try {
    const store = loadCameraStore()
    store[pageKey(wsId)] = { x: state.camera.x, y: state.camera.y, zoom: state.camera.zoom }
    localStorage.setItem(CAMERA_STORE_KEY, JSON.stringify(store))
  } catch { /* Ignore blocked storage. */ }
}

function restoreCameraForPage(wsId = state.activeWs) {
  const cam = loadCameraStore()[pageKey(wsId)]
  if (cam && Number.isFinite(cam.x) && Number.isFinite(cam.y) && Number.isFinite(cam.zoom)) {
    state.camera = { x: cam.x, y: cam.y, zoom: cam.zoom }
    return true
  }
  return false
}

let cameraSaveTimer = null
function saveCameraSoon() {
  if (cameraSaveTimer) clearTimeout(cameraSaveTimer)
  cameraSaveTimer = setTimeout(() => { cameraSaveTimer = null; saveCameraForPage() }, 400)
}

function windowSessionSnapshot() {
  const geom = (v) => ({
    left: v.style.left || "", top: v.style.top || "", width: v.style.width || "", height: v.style.height || "",
    pinned: Boolean(v.windowPinned), persistent: Boolean(v.windowPersistent),
    maximized: v.classList.contains("maximized"),
  })
  // 平铺状态下额外记录「平铺前的浮窗几何」，供刷新后取消平铺时还原。
  const restoreOf = (v) => {
    const previous = tiledWindowPositions?.get(v)
    if (!previous) return null
    return {
      left: previous.style.left || "", top: previous.style.top || "",
      width: previous.style.width || "", height: previous.style.height || "",
      maximized: Boolean(previous.maximized),
    }
  }
  const windows = []
  for (const [id, v] of contextWindows) windows.push({ type: "context", id, ...geom(v), restore: restoreOf(v) })
  for (const [id, v] of notebookWindows) windows.push({ type: "notebook", id, ...geom(v), restore: restoreOf(v) })
  for (const [id, v] of fileWindows) windows.push({ type: "file", id, owner: v.dataset.ownerNode || "", ...geom(v), restore: restoreOf(v) })
  return { version: 1, activeWs: state.activeWs || "", windows, tiled: Boolean(tiledWindowPositions), hidden: windowsHidden, tileMode }
}

let windowSessionTimer = null
function saveWindowSessionSoon() {
  if (windowSessionTimer) clearTimeout(windowSessionTimer)
  windowSessionTimer = setTimeout(() => {
    windowSessionTimer = null
    try { localStorage.setItem(WINDOW_SESSION_KEY, JSON.stringify(windowSessionSnapshot())) } catch { /* Ignore blocked storage. */ }
  }, 300)
}

function saveWindowSessionNow() {
  if (windowSessionTimer) { clearTimeout(windowSessionTimer); windowSessionTimer = null }
  try { localStorage.setItem(WINDOW_SESSION_KEY, JSON.stringify(windowSessionSnapshot())) } catch { /* Ignore blocked storage. */ }
}

/** 窗口是否属于当前页面：全局视图显示所有，具体页面只显示本页节点的窗口。 */
function windowPageVisible(viewer) {
  if (!state.activeWs) return true
  const nodeId = viewer.dataset.nodeId || viewer.dataset.ownerNode
  if (nodeId) return isOnPage(nodeId, state.activeWs)
  return true
}

function windowEffectivelyVisible(viewer) {
  if (viewer.windowHidden) return false
  if (windowsHidden && !viewer.windowPersistent) return false
  return windowPageVisible(viewer)
}

async function restoreWindowSession() {
  let session = null
  try { session = JSON.parse(localStorage.getItem(WINDOW_SESSION_KEY) || "null") } catch { session = null }
  if (!session || !Array.isArray(session.windows)) return
  if (["grid", "stage"].includes(session.tileMode)) {
    tileMode = session.tileMode
    const sel = document.getElementById("tileModeSelect")
    if (sel) sel.value = tileMode
  }
  if (session.activeWs && state.graph.workspaces.some((w) => w.id === session.activeWs)) {
    state.activeWs = session.activeWs
    renderTabs()
  }
  restoreCameraForPage()
  const app = document.getElementById("app")
  // 一次性恢复：先全部隐藏并禁用过渡，循环结束后统一显示，避免窗口逐个蹦出。
  app.classList.add("session-restoring")
  const restored = []
  for (const item of session.windows) {
    try {
      let viewer = null
      if (item.type === "context" && state.nodesById.has(item.id) && state.nodesById.get(item.id).kind !== "notebook") {
        viewer = await openContextViewer(item.id)
      } else if (item.type === "notebook" && state.nodesById.get(item.id)?.kind === "notebook") {
        viewer = await openNotebookViewer(item.id)
      } else if (item.type === "file") {
        viewer = await openFileViewer(item.id, item.owner || null)
      }
      if (!viewer) continue
      if (item.width) viewer.style.width = item.width
      if (item.height) viewer.style.height = item.height
      if (item.left) { viewer.style.left = item.left; viewer.style.right = "auto" }
      if (item.top) viewer.style.top = item.top
      if (item.pinned) { viewer.windowPinned = true; viewer.style.zIndex = "45" }
      if (item.persistent) viewer.windowPersistent = true
      if (item.maximized) viewer.classList.add("maximized")
      viewer.style.visibility = "hidden"
      restored.push({ item, viewer })
    } catch { /* 单个窗口恢复失败不影响其它窗口 */ }
  }
  try {
    if (session.tiled && managedWindows().length) {
      // 平铺会话：把「平铺前的浮窗几何」重新装回内存，取消平铺时才能回到原来的小窗排布。
      const withRestore = restored.filter(({ item, viewer }) => item.restore && !viewer.windowPinned)
      if (withRestore.length) {
        tiledWindowPositions = new Map()
        tileOrder = []
        for (const { item, viewer } of withRestore) {
          tiledWindowPositions.set(viewer, {
            style: { left: item.restore.left, top: item.restore.top, width: item.restore.width, height: item.restore.height, zIndex: "" },
            maximized: Boolean(item.restore.maximized),
          })
          tileOrder.push(viewer)
        }
        for (const viewer of managedWindows()) {
          if (!viewer.windowPinned && !tileOrder.includes(viewer) && windowEffectivelyVisible(viewer)) tileOrder.push(viewer)
        }
        retileContextWindows()
      } else {
        tileContextWindows()
      }
    }
    if (session.hidden) hideAllWindows()
    updatePinButtons()
    updatePersistButtons()
    updateTilingButtons()
    applyWindowVisibility()
  } finally {
    // 无论恢复过程是否出错，都要解除隐藏并统一显示，避免窗口永久不可见。
    app.classList.remove("session-restoring")
    for (const { viewer } of restored) viewer.style.visibility = ""
  }
  draw()
}


function isLightTheme() {
  const theme = document.body.dataset.theme
  if (theme === "light" || theme === "mac") return true
  if (theme === "mac-dark") return false
  if (theme === "system") return Boolean(window.matchMedia?.("(prefers-color-scheme: light)").matches)
  return false
}

function nodeIsActive(node) {
  const status = node.opencodeSessionId ? state.runtimeStatus.get(node.opencodeSessionId) : null
  return state.runtimeStatusAvailable && status?.status === "busy"
}

function nodeIsEmpty(node) {
  return node.kind !== "notebook" && !nodeIsActive(node) && node.tokenCount === 0
}

function linkIsActive(link) {
  return state.activeLinks.has(link.id) ||
    nodeIsActive(state.nodesById.get(link.from) ?? {}) || nodeIsActive(state.nodesById.get(link.to) ?? {})
}

function workspacesOfNode(nodeId) {
  return state.graph.members.filter((m) => m.nodeId === nodeId).map((m) => m.workspaceId)
}

function radiusOf(id) {
  return nodeRadius(state.nodesById.get(id)?.tokenCount ?? 0)
}

function nodeTitle(id) {
  return nodeDisplayTitle(id)
}

const PLACEHOLDER_TITLES = new Set([
  "", "未命名节点", "未命名会话", "未命名", "新节点", "新会话", "草稿本", "摘录本",
  "子节点", "子会话", "未命名笔记本",
  "Untitled", "New Session", "New Chat", "New Node",
])

/** 判断标题是否仍是占位/默认值（用于决定是否用 AI 生成标题）。 */
function isPlaceholderTitle(title) {
  const value = String(title ?? "").trim()
  return !value || PLACEHOLDER_TITLES.has(value) || /^new session\b/i.test(value)
}

/** 节点是否需要自动生成标题：占位标题，或摘录创建的「临时标题」在有模型输出后也应重命名。 */
function needsAutoTitle(node) {
  if (!node) return false
  return isPlaceholderTitle(node.title) || node.meta?.titleProvisional === true
}

function makeBadge(value, className) {  const badge = document.createElement("span")
  badge.className = className
  badge.textContent = value
  badge.title = value
  return badge
}

function renderPageBadges(container, nodeId) {
  if (!container) return
  const pages = workspacesOfNode(nodeId).map((id) => state.graph.workspaces.find((w) => w.id === id)?.name ?? id)
  container.replaceChildren(...pages.map((name) => makeBadge(name, "context-page")))
  container.hidden = pages.length === 0
}

function renderContextViewerHeading(viewer, node) {
  viewer.headingNode = node ?? null
  viewer.querySelector(".context-viewer-title").textContent = node ? nodeDisplayTitle(node.id) : "会话"
  renderPageBadges(viewer.querySelector(".context-viewer-pages"), node?.id)
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  )
}

/** 复制文本到剪贴板：优先异步 API，非安全上下文用隐藏文本域兜底。 */
async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement("textarea")
      area.value = text
      area.setAttribute("readonly", "")
      area.style.position = "fixed"
      area.style.opacity = "0"
      document.body.append(area)
      area.select()
      const ok = document.execCommand("copy")
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

function formatSize(n) {
  if (typeof n !== "number") return ""
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 笔记本图标颜色：默认低饱和薄荷色，可由节点 meta.iconColor 覆盖。 */
const DEFAULT_NOTEBOOK_ICON_COLOR = "#8fc7bd"
function notebookIconColor(node) {
  const value = typeof node?.meta?.iconColor === "string" ? node.meta.iconColor.trim() : ""
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : DEFAULT_NOTEBOOK_ICON_COLOR
}

function withAlpha(hex, alpha) {
  const value = hex.replace("#", "")
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function formatTime(value) {
  if (!value) return "暂无记录"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "暂无记录"
  const pad = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function updateNodeHoverInfo(nodeId) {
  const node = state.nodesById.get(nodeId)
  if (!node || !state.hoverPosition) { nodeHoverInfo.classList.remove("open"); return }
  const status = !node.opencodeSessionId ? "无会话" : !state.runtimeStatusAvailable ? "状态未知" : nodeIsActive(node) ? "运行中" : "闲置"
  const pages = workspacesOfNode(nodeId).map((id) => state.graph.workspaces.find((w) => w.id === id)?.name ?? id)
  nodeHoverInfo.innerHTML = `<strong>${escapeHtml(nodeDisplayTitle(nodeId))}</strong><div>状态：${status}</div><div>页面：${escapeHtml(pages.join("、") || "未加入页面")}</div><div>创建：${formatTime(node.createdAt)}</div><div>最近活跃：${node.opencodeSessionId ? formatTime(node.lastActiveAt) : "无会话"}</div>`
  nodeHoverInfo.classList.add("open")
  const { x, y } = state.hoverPosition
  nodeHoverInfo.style.left = clamp(x + 14, 8, Math.max(8, window.innerWidth - nodeHoverInfo.offsetWidth - 8)) + "px"
  nodeHoverInfo.style.top = clamp(y + 14, 8, Math.max(8, window.innerHeight - nodeHoverInfo.offsetHeight - 8)) + "px"
}

// 行内公式：先由 marked 扩展识别成占位 span，DOMPurify 过滤后再用 KaTeX 渲染。
// 这样公式内容不会被 Markdown 的 * _ \ 转义规则破坏，KaTeX 生成的 HTML 也不经过净化器。
// 注意：marked 按扩展 name 注册 renderer，token.type 必须与 name 一致。
const nxMathExtension = {
  name: "nxMath",
  level: "inline",
  start(src) {
    const i = src.search(/\$\$|\\\[|\\\(|\$/)
    return i < 0 ? undefined : i
  },
  tokenizer(src) {
    const block = /^\$\$([\s\S]+?)\$\$/.exec(src) || /^\\\[([\s\S]+?)\\\]/.exec(src)
    if (block) return { type: "nxMath", raw: block[0], text: block[1].trim(), display: true }
    const inline = /^\\\(([\s\S]+?)\\\)/.exec(src)
      || /^\$(?!\s)([^\s$](?:[^\n$]*?[^\s$])?)\$(?!\$)/.exec(src)
    if (inline) return { type: "nxMath", raw: inline[0], text: inline[1].trim(), display: false }
    return undefined
  },
  renderer(token) {
    return `<span class="nx-math" data-nx-display="${token.display ? "1" : "0"}" data-nx-tex="${escapeHtml(token.text)}" data-nx-raw="${escapeHtml(token.raw)}"></span>`
  },
}
marked.use({ extensions: [nxMathExtension] })

function renderMathIn(root) {
  if (!root?.querySelectorAll) return
  root.querySelectorAll(".nx-math").forEach((el) => {
    const tex = el.dataset.nxTex ?? ""
    if (!tex) return
    try {
      el.innerHTML = katex.renderToString(tex, {
        displayMode: el.dataset.nxDisplay === "1",
        throwOnError: false,
        trust: false,
        strict: "ignore",
      })
      el.classList.add("nx-math-rendered")
      if (el.dataset.nxDisplay === "1") el.classList.add("nx-math-block")
    } catch {
      el.textContent = tex
    }
  })
}

function renderMarkdown(md) {
  const html = DOMPurify.sanitize(marked.parse(String(md ?? ""), { gfm: true, breaks: true }), {
    USE_PROFILES: { html: true }, FORBID_TAGS: ["style"], FORBID_ATTR: ["style"],
  })
  const content = document.createElement("div")
  content.innerHTML = html
  content.querySelectorAll("a[href]").forEach((link) => {
    link.target = "_blank"
    link.rel = "noopener noreferrer"
  })
  renderMathIn(content)
  return `<div class="fv-md">${content.innerHTML}</div>`
}

// 选区内若含公式，用原始 LaTeX 源码替换渲染后的 KaTeX DOM，摘录 / 复制才能拿到 md 源码。
function rangeTextWithMath(range) {
  if (!range) return ""
  let clone
  try { clone = range.cloneContents() } catch { return range.toString?.() ?? "" }
  const holder = document.createElement("div")
  holder.append(clone)
  holder.querySelectorAll(".nx-math").forEach((el) => {
    el.replaceWith(document.createTextNode(el.dataset.nxRaw ?? el.dataset.nxTex ?? ""))
  })
  return holder.textContent
}

// Ctrl/Cmd+C 时若选区含公式，覆盖剪贴板为带 LaTeX 源码的纯文本。
document.addEventListener("copy", (event) => {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount || !event.clipboardData) return
  const range = sel.getRangeAt(0)
  if (!range.cloneContents().querySelector?.(".nx-math")) return
  event.clipboardData.setData("text/plain", rangeTextWithMath(range))
  event.preventDefault()
})

/** 把纯文本里的本地文件路径变成可点击元素（点击打开预览并在文件树高亮）。 */
const FILE_PATH_RE = /((?:~|\.\.?)?\/[A-Za-z0-9._@%+\-]+(?:\/[A-Za-z0-9._@%+\-]+)*\.[A-Za-z0-9]{1,8}|[A-Za-z0-9._@%+\-]+\/[A-Za-z0-9._@%+\-/]*\.[A-Za-z0-9]{1,8})/g

function linkifyFilePaths(root) {
  if (!root || !root.querySelectorAll) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || parent.closest("a, .nodex-path, textarea, input, script, style")) return NodeFilter.FILTER_REJECT
      if (!node.nodeValue || !node.nodeValue.includes("/")) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const targets = []
  let current
  while ((current = walker.nextNode())) targets.push(current)
  for (const node of targets) {
    const text = node.nodeValue
    FILE_PATH_RE.lastIndex = 0
    if (!FILE_PATH_RE.test(text)) continue
    FILE_PATH_RE.lastIndex = 0
    const frag = document.createDocumentFragment()
    let last = 0
    let match
    while ((match = FILE_PATH_RE.exec(text))) {
      if (/:\/\/$/.test(text.slice(Math.max(0, match.index - 3), match.index))) continue
      frag.append(document.createTextNode(text.slice(last, match.index)))
      const span = document.createElement("span")
      span.className = "nodex-path"
      span.dataset.path = match[1]
      span.textContent = match[1]
      span.title = `打开 ${match[1]}`
      frag.append(span)
      last = match.index + match[1].length
    }
    if (last === 0) continue
    frag.append(document.createTextNode(text.slice(last)))
    node.parentNode.replaceChild(frag, node)
  }
}

async function revealFsPath(path) {
  if (!path || fsPanel.hidden) return
  const dir = fsDirname(path)
  if (!dir) return
  try {
    renderFsTree(fsTreeEl, await api(`/fs/list?path=${encodeURIComponent(dir)}`))
    const row = fsTreeEl.querySelector(`.fs-row[data-path="${CSS.escape(path)}"]`)
    if (!row) return
    row.classList.add("fs-row-highlight")
    row.scrollIntoView({ block: "nearest" })
    setTimeout(() => row.classList.remove("fs-row-highlight"), 2400)
  } catch { /* 路径不在允许根内时忽略高亮 */ }
}

document.addEventListener("click", (event) => {
  const el = event.target.closest(".nodex-path")
  if (!el) return
  event.preventDefault()
  event.stopPropagation()
  if (IS_VSCODE_HOST) return
  const path = el.dataset.path
  void openFileViewer(path)
  void revealFsPath(path)
})

/** 把摘录来源标记替换为可悬浮点击的「↗ 来源」按钮。 */
function attachExcerptSources(root) {
  root.querySelectorAll(".nodex-excerpt-src").forEach((marker) => {
    const nodeId = marker.dataset.nodexNode
    const messageId = marker.dataset.nodexMid || ""
    const from = marker.dataset.nodexFrom || ""
    const button = document.createElement("button")
    button.type = "button"
    button.className = "nodex-src-btn"
    button.textContent = "↗ 来源"
    button.title = from ? `跳转到「${from}」的原始输出` : "跳转到来源"
    button.onclick = (event) => {
      event.preventDefault()
      event.stopPropagation()
      void jumpToSource(nodeId, messageId)
    }
    marker.replaceWith(button)
  })
}

/** 渲染笔记本预览：保留原始 Markdown，并挂上摘录来源跳转按钮。 */
function renderNotebookPreview(previewEl, doc) {
  const source = String(doc ?? "")
  previewEl.innerHTML = source.trim() ? renderMarkdown(source) : ""
  attachExcerptSources(previewEl)
}

/** 打开来源节点的会话窗并滚动高亮对应消息。 */
async function jumpToSource(nodeId, messageId) {
  if (!nodeId) return
  try {
    const viewer = await openContextViewer(nodeId)
    let target = messageId ? viewer.querySelector(`.context-message[data-mid="${CSS.escape(messageId)}"]`) : null
    if (!target && messageId) {
      viewer.viewOptions = { ...viewer.viewOptions, outputOnly: false, showInput: true, showThinking: true }
      await reloadContextViewer(nodeId)
      target = viewer.querySelector(`.context-message[data-mid="${CSS.escape(messageId)}"]`)
    }
    if (!target) {
      statusEl.textContent = "未找到来源消息（可能已被压缩或删除）"
      return
    }
    focusContextViewer(viewer)
    target.scrollIntoView({ block: "center", behavior: "smooth" })
    target.classList.add("nodex-flash")
    setTimeout(() => target.classList.remove("nodex-flash"), 1800)
  } catch (error) {
    statusEl.textContent = `跳转失败: ${error.message}`
  }
}

// ---------------- 布局与相机 ----------------
function layout(seedAll = false) {
  if (seedAll) {
    state.positions.clear()
    state.anchors.clear()
  }
  seedLayout({
    nodes: state.graph.nodes,
    members: state.graph.members,
    positions: state.positions,
    anchors: state.anchors,
  })
  relax({
    nodes: state.graph.nodes,
    positions: state.positions,
    anchors: state.anchors,
    pinned: state.pinned,
    radiusOf,
  })
}

// ---------------- 页面（选项卡） ----------------
// 工作区即「页面」：一个节点可同时属于多个页面；切页时只显示本页节点，
// 跨页连线以「幽灵节点」出现在页边界，点击可跳转。

function isOnPage(nodeId, wsId) {
  return memberOnPage(state.graph.members, nodeId, wsId)
}

function isVisibleNode(nodeId) {
  return isOnPage(nodeId, state.activeWs)
}

function visibleNodes() {
  return state.graph.nodes.filter((n) => isVisibleNode(n.id))
}

function nodesOfPage(wsId) {
  return state.graph.nodes.filter((n) => isOnPage(n.id, wsId))
}

/**
 * 同一页面内重名节点 / 笔记本按创建顺序加 1、2、3 后缀，便于区分。
 * 结果缓存在 state.displayTitles，refresh 与切页时重算。
 */
function computeDisplayTitles() {
  const scope = state.activeWs ? nodesOfPage(state.activeWs) : state.graph.nodes
  const groups = new Map()
  for (const node of scope) {
    const key = String(node.title ?? "").trim() || "未命名"
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(node)
  }
  const map = new Map()
  for (const [key, list] of groups) {
    if (list.length < 2) continue
    list.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || a.id.localeCompare(b.id))
    list.forEach((node, index) => map.set(node.id, `${key} ${index + 1}`))
  }
  return map
}

function nodeDisplayTitle(nodeId) {
  const node = state.nodesById.get(nodeId)
  return state.displayTitles?.get(nodeId) ?? node?.title ?? nodeId
}

/**
 * 跨页连线：本页的一端保留，另一端放到「幽灵节点」。
 * 幽灵朝向真实节点所在方向，沿宿主节点外环排布，保证可见且方向可读。
 */
function computeGhosts() {
  return computeGhostsPure({
    links: state.graph.links,
    members: state.graph.members,
    positions: state.positions,
    activeWs: state.activeWs,
    radiusOf,
  })
}

function fitView() {
  const nodes = visibleNodes()
  state.camera = computeFit({
    nodes: nodes.length ? nodes : state.graph.nodes,
    positions: state.positions,
    radiusOf,
    viewport: viewport(),
  })
}

function zoomAt(sx, sy, factor) {
  state.camera = zoomedCamera(state.camera, viewport(), sx, sy, factor, ZOOM_LIMITS)
  saveCameraSoon()
}

const screenOf = (wx, wy) => toScreen(state.camera, viewport(), wx, wy)
const worldOf = (sx, sy) => toWorld(state.camera, viewport(), sx, sy)

// ---------------- 绘制 ----------------
function resize() {
  const dpr = window.devicePixelRatio || 1
  const { w, h } = viewport()
  canvas.width = Math.floor(w * dpr)
  canvas.height = Math.floor(h * dpr)
  canvas.style.width = w + "px"
  canvas.style.height = h + "px"
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  updateMaximizedVars()
}

let activityTimer = 0

/**
 * 从节点到其窗口画一束渐变梯形「投影」，让人一眼看出窗口属于哪个节点。
 * 画布在窗口之下，光锥在窗口处淡出，形成从节点到窗口逐渐变透明的效果。
 */
function drawWindowBeams(light) {
  const z = state.camera.zoom
  for (const viewer of managedWindows()) {
    if (!viewer.isConnected || !viewer.classList.contains("open")) continue
    if (!windowEffectivelyVisible(viewer)) continue
    const nodeId = viewer.dataset.nodeId || viewer.dataset.ownerNode
    if (!nodeId || !isVisibleNode(nodeId)) continue
    const p = state.positions.get(nodeId)
    if (!p) continue
    const rect = viewer.getBoundingClientRect()
    if (rect.width < 8 || rect.height < 8) continue
    const node = state.nodesById.get(nodeId)
    const radius = Math.max(6, nodeRadius(node?.tokenCount ?? 0) * z)
    const c = screenOf(p.x, p.y)
    const qx = clamp(c.x, rect.left, rect.right)
    const qy = clamp(c.y, rect.top, rect.bottom)
    let dx = qx - c.x, dy = qy - c.y
    const dist = Math.hypot(dx, dy) || 1
    dx /= dist; dy /= dist
    const perpX = -dy, perpY = dx
    const a1 = { x: c.x + perpX * radius, y: c.y + perpY * radius }
    const a2 = { x: c.x - perpX * radius, y: c.y - perpY * radius }
    const half = Math.max(rect.width, rect.height) * 0.36
    const b1 = { x: qx + perpX * half, y: qy + perpY * half }
    const b2 = { x: qx - perpX * half, y: qy - perpY * half }
    const ws = workspacesOfNode(nodeId)
    const color = ws.length ? (state.graph.workspaces.find((w) => w.id === ws[0])?.color || "#6366f1") : (light ? "#94a3b8" : "#64748b")
    const grad = ctx.createLinearGradient(c.x, c.y, qx, qy)
    grad.addColorStop(0, withAlpha(color, light ? 0.26 : 0.32))
    grad.addColorStop(1, withAlpha(color, 0.02))
    ctx.beginPath()
    ctx.moveTo(a1.x, a1.y)
    ctx.lineTo(b1.x, b1.y)
    ctx.lineTo(b2.x, b2.y)
    ctx.lineTo(a2.x, a2.y)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()
  }
}

function draw() {
  if (activityTimer) clearTimeout(activityTimer)
  activityTimer = 0
  const dpr = window.devicePixelRatio || 1
  const { w, h } = viewport()
  const z = state.camera.zoom
  const k = 1 / z
  const light = isLightTheme()
  const animate = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  let hasVisibleActiveNode = false

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  ctx.save()
  ctx.translate(w / 2, h / 2)
  ctx.scale(z, z)
  ctx.translate(-state.camera.x, -state.camera.y)

  // 网格
  const tl = worldOf(0, 0)
  const br = worldOf(w, h)
  const step = 48
  ctx.strokeStyle = light ? "rgba(100,116,139,.13)" : "#151922"
  ctx.lineWidth = (light ? 0.7 : 1) * k
  ctx.beginPath()
  for (let x = Math.floor(tl.x / step) * step; x < br.x; x += step) {
    ctx.moveTo(x, tl.y); ctx.lineTo(x, br.y)
  }
  for (let y = Math.floor(tl.y / step) * step; y < br.y; y += step) {
    ctx.moveTo(tl.x, y); ctx.lineTo(br.x, y)
  }
  ctx.stroke()

  // 页面颜色：仅用于节点配色，不再画整块画布框
  const wsColors = new Map()
  for (const ws of state.graph.workspaces) wsColors.set(ws.id, ws.color || "#6366f1")

  // 连接线
  const selectedLinkId = state.selection?.type === "link" ? state.selection.id : null
  const selectedNodeId = state.selection?.type === "node" ? state.selection.id : null

  for (const link of state.graph.links) {
    // 只画本页内部的连线；跨页连线交给幽灵节点表达
    if (!isVisibleNode(link.from) || !isVisibleNode(link.to)) continue
    const a = state.positions.get(link.from)
    const b = state.positions.get(link.to)
    if (!a || !b) continue
    const isPortal = link.kind === "portal"
    const isSel = link.id === selectedLinkId || (state.region?.nodeIds.includes(link.from) && state.region.nodeIds.includes(link.to))
    const isHover = link.id === state.hoverLink
    const isActive = linkIsActive(link)

    ctx.globalAlpha = isActive || isSel || isHover ? 1 : 0.32
    ctx.strokeStyle = isSel
      ? (light ? "#111827" : "#ffffff")
      : isHover
        ? "#4f46e5"
        : isPortal
          ? "#c026d3"
          : (light ? "#475569" : "#4b5563")
    ctx.lineWidth = (isSel ? 3 : isHover ? 2.4 : isActive ? 1.6 : 1.2) * k
    ctx.setLineDash(isPortal || !isActive ? [6 * k, 5 * k] : [])
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    ctx.setLineDash([])

    // 选中/悬停连线时在中点画一个可点击的操作手柄
    if (isSel || isHover) {
      const m = linkMidpoint(state.positions, link)
      ctx.beginPath()
      ctx.arc(m.x, m.y, (isSel ? 9 : 7) * k, 0, Math.PI * 2)
      ctx.fillStyle = isSel ? "#ffffff" : "#a5b4fc"
      ctx.fill()
      ctx.fillStyle = "#0b0d12"
      ctx.font = `700 ${11 * k}px ui-sans-serif, system-ui`
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText("⋯", m.x, m.y + 0.5 * k)
      ctx.textAlign = "left"
      ctx.textBaseline = "alphabetic"
    }
  }

  ctx.globalAlpha = 1

  // Shift 拖拽建链预览
  if (state.connect) {
    const a = state.positions.get(state.connect.from)
    if (a) {
      const t = state.connect.targetId ? state.positions.get(state.connect.targetId) : null
      const ex = t ? t.x : state.connect.x
      const ey = t ? t.y : state.connect.y
      ctx.strokeStyle = "#a5b4fc"
      ctx.lineWidth = 2 * k
      ctx.setLineDash([7 * k, 5 * k])
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(ex, ey)
      ctx.stroke()
      ctx.setLineDash([])
      if (t) {
        ctx.beginPath()
        ctx.arc(t.x, t.y, nodeRadius(state.nodesById.get(state.connect.targetId)?.tokenCount ?? 0) + 6 * k, 0, Math.PI * 2)
        ctx.strokeStyle = "#a5b4fc"
        ctx.lineWidth = 3 * k
        ctx.stroke()
      }
    }
  }

  // 幽灵节点：跨页连线在本页的入口
  state.ghosts = computeGhosts()
  for (const g of state.ghosts) {
    const host = state.positions.get(g.hostId)
    if (host) {
      ctx.strokeStyle = "#6b7280"
      ctx.lineWidth = 1.4 * k
      ctx.setLineDash([4 * k, 4 * k])
      ctx.beginPath()
      ctx.moveTo(host.x, host.y)
      ctx.lineTo(g.x, g.y)
      ctx.stroke()
      ctx.setLineDash([])
    }

    const gr = 11
    ctx.beginPath()
    ctx.arc(g.x, g.y, gr, 0, Math.PI * 2)
    ctx.fillStyle = state.hoverGhost === g.id ? "#374151" : "#1b2030"
    ctx.fill()
    ctx.strokeStyle = "#9ca3af"
    ctx.lineWidth = 1.5 * k
    ctx.setLineDash([3 * k, 3 * k])
    ctx.stroke()
    ctx.setLineDash([])

    ctx.fillStyle = "#9ca3af"
    ctx.font = `700 ${10 * k}px ui-sans-serif, system-ui`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText("↗", g.x, g.y + 0.5 * k)
    ctx.textBaseline = "alphabetic"

    const gLabel = nodeTitle(g.id)
    const shown = gLabel.length > 10 ? gLabel.slice(0, 10) + "…" : gLabel
    ctx.fillStyle = "#8b93a7"
    ctx.font = `${10 * k}px ui-sans-serif, system-ui`
    ctx.fillText(shown, g.x, g.y + gr + 12 * k)
    ctx.textAlign = "left"
  }

  // 节点（仅本页）
  for (const node of visibleNodes()) {
    const p = state.positions.get(node.id)
    if (!p) continue
    const r = nodeRadius(node.tokenCount)
    const ws = workspacesOfNode(node.id)
    const isOverlap = ws.length > 1
    const isSelected = selectedNodeId === node.id || state.region?.nodeIds.includes(node.id)
    const isHover = state.hoverNode === node.id
    const isConnectTarget = state.connect?.targetId === node.id
    const isConnectFrom = state.connect?.from === node.id
    const isActive = nodeIsActive(node)
    const isEmpty = nodeIsEmpty(node)
    if (isActive) hasVisibleActiveNode = true

    ctx.globalAlpha = isEmpty ? 0.32 : 1
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    // 笔记本不填充圆形，只保留低饱和度描边与图标，避免盖住画布
    if (node.kind !== "notebook") {
      ctx.fillStyle = ws.length === 0 ? (light ? "#94a3b8" : "#2f3646") : wsColors.get(ws[0]) || "#4f46e5"
      ctx.fill()
    }

    if (isActive) {
      ctx.beginPath()
      ctx.arc(p.x, p.y, r + 6 * k, 0, Math.PI * 2)
      ctx.strokeStyle = "#22c55e"
      ctx.lineWidth = 2.4 * k
      ctx.setLineDash([])
      ctx.stroke()
      if (animate) {
        const start = performance.now() / 550
        ctx.beginPath()
        ctx.arc(p.x, p.y, r + 6 * k, start, start + Math.PI * .6)
        ctx.strokeStyle = "#bbf7d0"
        ctx.lineWidth = 3.4 * k
        ctx.stroke()
      }
    }

    // 笔记本：低饱和度虚线环 + 简洁笔记本图标（无圆形填充），颜色可由 meta.iconColor 自定义
    if (node.kind === "notebook") {
      const iconColor = notebookIconColor(node)
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.strokeStyle = withAlpha(iconColor, light ? 0.7 : 0.78)
      ctx.lineWidth = 1.8 * k
      ctx.setLineDash([5 * k, 4 * k])
      ctx.stroke()
      ctx.setLineDash([])

      const iw = Math.max(10, Math.min(r * 1.05, 22 * k))
      const ih = iw * 1.28
      const x0 = p.x - iw / 2, y0 = p.y - ih / 2
      ctx.save()
      ctx.fillStyle = withAlpha(iconColor, light ? 0.16 : 0.2)
      ctx.strokeStyle = withAlpha(iconColor, 0.95)
      ctx.lineWidth = Math.max(1, 1.3 * k)
      ctx.beginPath()
      if (ctx.roundRect) ctx.roundRect(x0, y0, iw, ih, 2 * k)
      else ctx.rect(x0, y0, iw, ih)
      ctx.fill()
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(x0 + iw * 0.3, y0)
      ctx.lineTo(x0 + iw * 0.3, y0 + ih)
      ctx.stroke()
      for (let line = 1; line <= 3; line++) {
        const yy = y0 + ih * (line / 4)
        ctx.beginPath()
        ctx.moveTo(x0 + iw * 0.44, yy)
        ctx.lineTo(x0 + iw * 0.86, yy)
        ctx.stroke()
      }
      ctx.restore()
    }

    if (isHover || isConnectTarget) {
      ctx.strokeStyle = isConnectTarget ? "#a5b4fc" : "#8b93a7"
      ctx.lineWidth = 2 * k
      ctx.stroke()
    }
    if (isConnectFrom) {
      ctx.strokeStyle = "#a5b4fc"
      ctx.lineWidth = 3 * k
      ctx.setLineDash([5 * k, 4 * k])
      ctx.beginPath()
      ctx.arc(p.x, p.y, r + 9 * k, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    }

    if (isOverlap) {
      ctx.strokeStyle = "#fcd34d"
      ctx.lineWidth = 3 * k
      ctx.stroke()
    }
    if (isSelected) {
      ctx.strokeStyle = "#ffffff"
      ctx.lineWidth = 2 * k
      ctx.setLineDash([4 * k, 3 * k])
      ctx.beginPath()
      ctx.arc(p.x, p.y, r + 7 * k, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
    }

    ctx.fillStyle = light ? "#1e293b" : "#e6e8ee"
    const fontPx = 12 * k
    ctx.font = `${fontPx}px ui-sans-serif, system-ui`
    ctx.textAlign = "center"
    // 节点标题按可用宽度换行显示（最多 3 行，超出加省略号），避免长标题被截断。
    const maxLabelWidth = Math.max(120 * k, r * 2.4)
    const labelLines = wrapCanvasText(ctx, nodeDisplayTitle(node.id), maxLabelWidth, 3)
    const lineHeight = fontPx + 3
    labelLines.forEach((line, index) => ctx.fillText(line, p.x, p.y + r + 16 * k + index * lineHeight))

    ctx.textAlign = "left"
    ctx.globalAlpha = 1
  }

  ctx.restore()
  drawWindowBeams(light)
  if (state.lasso?.moved || state.region) {
    const points = state.lasso?.moved ? state.lasso.points : state.region.points.map((point) => screenOf(point.x, point.y))
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (const point of points.slice(1)) ctx.lineTo(point.x, point.y)
    ctx.closePath()
    ctx.fillStyle = light ? "rgba(22,163,74,.12)" : "rgba(74,222,128,.12)"
    ctx.fill()
    ctx.strokeStyle = light ? "#15803d" : "#4ade80"
    ctx.lineWidth = 2
    ctx.setLineDash([7, 4])
    ctx.stroke()
    ctx.restore()
  }
  if (panel.classList.contains("open")) positionPanel()
  positionLinkMenu()
  zoomLabel.textContent = Math.round(z * 100) + "%"
  if (hasVisibleActiveNode && animate && !document.hidden) activityTimer = setTimeout(draw, 40)
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) draw() })

/** 按画布文本宽度换行（中文逐字），最多 maxLines 行，超出用省略号收尾。 */
function wrapCanvasText(ctx, text, maxWidth, maxLines) {
  const chars = [...String(text ?? "")]
  if (!chars.length) return [""]
  const lines = []
  let current = ""
  for (let i = 0; i < chars.length; i++) {
    const next = current + chars[i]
    if (current && ctx.measureText(next).width > maxWidth) {
      lines.push(current)
      current = chars[i]
      if (lines.length === maxLines - 1) {
        const rest = current + chars.slice(i + 1).join("")
        let tail = rest
        while (tail && ctx.measureText(tail + "…").width > maxWidth) tail = tail.slice(0, -1)
        lines.push(tail.length < rest.length ? tail + "…" : tail)
        return lines
      }
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : [""]
}

let drawScheduled = false
function scheduleDraw() {
  if (drawScheduled) return
  drawScheduled = true
  requestAnimationFrame(() => { drawScheduled = false; draw() })
}

// ---------------- 面板定位 ----------------
function panelAnchorScreen() {
  const sel = state.selection
  if (!sel) return null

  if (sel.type === "node") {
    const p = state.positions.get(sel.id)
    if (!p) return null
    return { point: screenOf(p.x, p.y), radiusPx: nodeRadius(state.nodesById.get(sel.id)?.tokenCount ?? 0) * state.camera.zoom }
  }

  const link = state.graph.links.find((l) => l.id === sel.id)
  if (!link) return null
  const m = linkMidpoint(state.positions, link)
  if (!m) return null
  return { point: screenOf(m.x, m.y), radiusPx: 8 }
}

function positionPanel() {
  if (state.panelDetached) { panel.classList.add("open"); return }
  const anchor = panelAnchorScreen()
  if (!anchor) {
    panel.classList.remove("open")
    return
  }
  const { left, top } = anchorPanel({
    nodeScreen: anchor.point,
    nodeRadiusPx: anchor.radiusPx,
    panel: { w: panel.offsetWidth || 330, h: panel.offsetHeight || 300 },
    viewport: viewport(),
  })
  panel.style.left = left + "px"
  panel.style.top = top + "px"
  panel.classList.add("open")
}

// ---------------- 命中测试 ----------------
function hitTestNode(sx, sy) {
  const world = worldOf(sx, sy)
  for (const node of [...visibleNodes()].reverse()) {
    const p = state.positions.get(node.id)
    if (!p) continue
    const r = nodeRadius(node.tokenCount)
    if ((world.x - p.x) ** 2 + (world.y - p.y) ** 2 <= r * r) return node
  }
  return null
}

function hitTestGhost(sx, sy) {
  const world = worldOf(sx, sy)
  const tol = 16 / state.camera.zoom
  for (const g of state.ghosts) {
    if ((world.x - g.x) ** 2 + (world.y - g.y) ** 2 <= (11 + tol) ** 2) return g
  }
  return null
}

function hitTestAnyLink(sx, sy) {
  const world = worldOf(sx, sy)
  const links = state.graph.links.filter(
    (l) => isVisibleNode(l.from) && isVisibleNode(l.to),
  )
  // 容差按屏幕 10px 换算到世界坐标，保证手感与缩放无关
  return hitTestLink({
    links,
    positions: state.positions,
    world,
    tolerance: 10 / state.camera.zoom,
    radiusOf,
  })
}

// ---------------- API ----------------
// 统一超时：避免模型调用偶发长时间无响应时前端无限等待。
async function api(path, options = {}) {
  const { timeout = 240000, ...rest } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  let res
  try {
    res = await fetch(API + path, {
      headers: { "content-type": "application/json" },
      ...rest,
      signal: controller.signal,
    })
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`请求超时（>${Math.round(timeout / 1000)}s）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const error = new Error(data.error || `HTTP ${res.status}`)
    error.status = res.status
    error.data = data
    throw error
  }
  return data
}

async function streamPrompt(path, body, onEvent, timeout = 240000) {
  const controller = new AbortController()
  // 空闲超时：每收到一帧（含服务端心跳）就重置。等待用户回答问题时
  // 可能长时间没有业务数据，不能被总时长超时截断。
  let timer = setTimeout(() => controller.abort(), timeout)
  const resetTimer = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), timeout) }
  try {
    const res = await fetch(API + path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `HTTP ${res.status}`)
    }
    if (!res.body) throw new Error("服务器没有返回流")
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let donePayload = null
    while (true) {
      const chunk = await reader.read()
      resetTimer()
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done })
      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""
      for (const frame of frames) {
        const line = frame.split("\n").find((part) => part.startsWith("data: "))
        if (!line) continue
        const payload = JSON.parse(line.slice(6))
        onEvent(payload)
        if (payload.type === "done") donePayload = payload
        if (payload.type === "error") throw Object.assign(new Error(payload.error), { results: payload.results ?? [] })
      }
      if (chunk.done) break
    }
    return donePayload
  } catch (error) {
    if (error.name === "AbortError") throw new Error(`请求超时（>${Math.round(timeout / 1000)}s）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// ---------------- 主模型选择 ----------------
// 模型清单与默认值来自 OpenCode/NodeX 设置；本地缓存不覆盖服务端权威默认值。
const modelSelect = document.getElementById("modelSelect")

function currentModel() {
  return state.model ?? undefined
}

async function loadModels() {
  try {
    const data = await api("/models")
    state.models = data.models ?? []
    const pick =
      (data.default && state.models.find((m) => m.providerID === data.default.providerID && m.modelID === data.default.modelID))
    state.model = pick ? { providerID: pick.providerID, modelID: pick.modelID } : null
    modelSelect.innerHTML = '<option value="">OpenCode 默认</option>' + state.models
      .map((m) => `<option value="${escapeHtml(m.providerID + "/" + m.modelID)}">${escapeHtml(m.name || m.modelID)}</option>`)
      .join("")
    if (pick) modelSelect.value = `${pick.providerID}/${pick.modelID}`
    modelSelect.disabled = state.models.length === 0
    for (const viewer of contextWindows.values()) renderContextControls(viewer)
  } catch {
    modelSelect.innerHTML = '<option value="">模型不可用</option>'
    modelSelect.disabled = true
  }
}

async function loadAgents() {
  try {
    const data = await api("/agents")
    state.agents = data.agents ?? []
    state.defaultAgent = data.default ?? null
  } catch {
    state.agents = []
    state.defaultAgent = null
  }
  for (const viewer of contextWindows.values()) renderContextControls(viewer)
}

async function loadSettings() {
  try {
    const settings = await api("/settings")
    state.contextLimit = settings.contextLimit ?? 300000
    state.autoCompact = settings.autoCompact === true
  } catch { /* 保持默认上限 */ }
  for (const viewer of contextWindows.values()) renderContextUsage(viewer)
}

async function loadCommands() {  state.commandFetchAt = Date.now()
  try {
    state.commands = (await api("/commands", { timeout: 8000 })).commands ?? []
  } catch {
    state.commands = []
  }
  for (const viewer of contextWindows.values()) {
    if (!viewer.querySelector(".context-command-popover").hidden) updateCommandMenu(viewer)
    if (viewer.tuiPicker?.kind === "skills") renderTuiPicker(viewer)
  }
}

modelSelect?.addEventListener("change", async () => {
  const [providerID, ...restParts] = modelSelect.value.split("/")
  const modelID = restParts.join("/")
  const previous = state.model
  state.model = providerID && modelID ? { providerID, modelID } : null
  try {
    const saved = await api("/settings", { method: "PUT", body: JSON.stringify({ defaultModel: state.model }) })
    state.model = saved.defaultModel ?? null
    modelSelect.value = state.model ? `${state.model.providerID}/${state.model.modelID}` : ""
    statusEl.textContent = state.model ? `主模型已切换为 ${state.model.modelID}` : "使用 OpenCode 默认模型"
    for (const viewer of contextWindows.values()) renderContextControls(viewer)
  } catch (error) {
    state.model = previous
    modelSelect.value = previous ? `${previous.providerID}/${previous.modelID}` : ""
    for (const viewer of contextWindows.values()) renderContextControls(viewer)
    statusEl.textContent = "模型保存失败: " + error.message
  }
})

const themeSelect = document.getElementById("themeSelect")
const appearanceSelect = document.getElementById("appearanceSelect")

/** 读取主题偏好；兼容旧版把 dark/light/system 存成主题值的用法。 */
function loadThemePrefs() {
  let theme = "default"
  let appearance = "system"
  try { theme = localStorage.getItem("nodex.theme") || "default" } catch { /* Ignore blocked storage. */ }
  try { appearance = localStorage.getItem("nodex.appearance") || "system" } catch { /* Ignore blocked storage. */ }
  if (["dark", "light", "system"].includes(theme)) { appearance = theme; theme = "default" }
  if (!["default", "mac"].includes(theme)) theme = "default"
  if (!["dark", "light", "system"].includes(appearance)) appearance = "system"
  return { theme, appearance }
}

/** 主题 + 外观解析成实际生效的 data-theme 值。 */
function effectiveTheme(theme, appearance) {
  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches
  if (theme === "mac") return (appearance === "light" || (appearance === "system" && prefersLight)) ? "mac" : "mac-dark"
  return appearance
}

function themeBaseOf(effective) {
  if (effective === "mac") return "light"
  if (effective === "mac-dark") return "dark"
  if (effective === "light") return "light"
  if (effective === "system") return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark"
  return "dark"
}

function applyTheme(theme, appearance) {
  const prefs = theme === undefined
    ? loadThemePrefs()
    : { theme, appearance: appearance ?? loadThemePrefs().appearance }
  const effective = effectiveTheme(prefs.theme, prefs.appearance)
  const base = themeBaseOf(effective)
  document.documentElement.dataset.theme = effective
  document.body.dataset.theme = effective
  document.documentElement.dataset.themeBase = base
  document.body.dataset.themeBase = base
  themeSelect.value = prefs.theme
  appearanceSelect.value = prefs.appearance
  localStorage.setItem("nodex.theme", prefs.theme)
  localStorage.setItem("nodex.appearance", prefs.appearance)
  if (window.monaco?.editor) window.monaco.editor.setTheme(base === "light" ? "vs" : "vs-dark")
}
applyTheme()
themeSelect.addEventListener("change", () => { applyTheme(themeSelect.value, appearanceSelect.value); draw() })
appearanceSelect.addEventListener("change", () => { applyTheme(themeSelect.value, appearanceSelect.value); draw() })
window.matchMedia?.("(prefers-color-scheme: light)").addEventListener("change", () => {
  applyTheme(); draw()
})

async function refreshRuntimeStatus() {
  try {
    const data = await api("/runtime/status", { timeout: 8000 })
    state.runtimeStatusAvailable = data.available === true
    state.runtimeStatus = new Map(Object.entries(data.sessions ?? {}))
    for (const node of state.graph.nodes) {
      if (Object.hasOwn(data.activity ?? {}, node.id)) node.lastActiveAt = data.activity[node.id] ?? undefined
    }
    for (const [nodeId, viewer] of contextWindows) {
      const node = state.nodesById.get(nodeId)
      setViewerAiRunning(viewer, viewerIsRunning(viewer))
      if (node) viewer.querySelector(".context-viewer-times").textContent = `创建 ${formatTime(node.createdAt)} · 最近活跃 ${node.opencodeSessionId ? formatTime(node.lastActiveAt) : "无会话"}`
      if (data.questionsAvailable) renderPendingQuestion(viewer, data.questions?.[nodeId]?.[0])
      const staleAt = node?.opencodeSessionId ? data.stale?.[node.opencodeSessionId] : null
      const status = viewer.querySelector(".context-send-status")
      const syncReply = viewer.needsReplySync && !sendingNodes.has(nodeId) && !state.runtimeStatus.has(node?.opencodeSessionId) && !viewer.questionRequest && state.runtimeStatusAvailable
      if (syncReply) {
        viewer.needsReplySync = false
        viewer.staleAt = staleAt ?? null
        void reloadContextViewer(nodeId).then(() => {
          if (contextWindows.get(nodeId) === viewer && viewer.lastCompletedReply) {
            status.textContent = "回复已完成，已从会话恢复"
          }
        })
      }
      if (staleAt) {
        if (viewer.staleAt !== staleAt) {
          viewer.staleAt = staleAt
          void reloadContextViewer(nodeId)
        }
        if (!sendingNodes.has(nodeId)) status.classList.remove("running")
      } else {
        viewer.staleAt = null
        if (data.questionsAvailable && viewer.questionRequest) {
          status.textContent = "等待回答"
          status.classList.remove("running")
        } else if (status.textContent === "回复已完成，已从会话恢复" || (status.textContent === "等待回答" && !viewer.questionRequest)) {
          status.textContent = ""
        }
      }
      viewer.querySelector(".context-send").disabled = Boolean(viewer.questionRequest || viewer.settingsPending)
      if (canDrainQueue({ statusAvailable: state.runtimeStatusAvailable, runtimeStatus: state.runtimeStatus, sessionId: node?.opencodeSessionId, sending: sendingNodes.has(nodeId), queueLength: viewer.messageQueue?.length ?? 0 })) void drainMessageQueue(viewer)
      // 空闲且已有完整回复、标题仍是占位：补一次 AI 标题（长任务恢复 / 历史遗留节点）。
      if (state.runtimeStatusAvailable && !sendingNodes.has(nodeId) && !state.runtimeStatus.has(node?.opencodeSessionId) &&
          !viewer.questionRequest && viewer.lastCompletedReply) {
        maybeGenerateNodeTitle(nodeId)
      }
      // 权威状态空闲、无待处理问答，却仍有未完成的尾部助手消息：本地标「已中断」。
      const abortedId = abortedTailMessageId(viewer.lastMessages, {
        statusAvailable: state.runtimeStatusAvailable,
        active: state.runtimeStatus.has(node?.opencodeSessionId),
        sending: sendingNodes.has(nodeId),
        hasQuestion: Boolean(viewer.questionRequest || data.questions?.[nodeId]?.length),
      })
      if (abortedId) markMessageAborted(viewer, abortedId)
    }
    if (state.hoverNode) updateNodeHoverInfo(state.hoverNode)
    draw()
  } catch {
    state.runtimeStatusAvailable = false
    state.runtimeStatus.clear()
    if (state.hoverNode) updateNodeHoverInfo(state.hoverNode)
    draw()
  }
}

/** 给被中断的尾部助手消息加「已中断」标记（幂等）。 */
function markMessageAborted(viewer, messageId) {
  const message = viewer.querySelector(`.context-message[data-mid="${CSS.escape(messageId)}"]`)
  if (!message || message.classList.contains("aborted")) return
  message.classList.add("aborted")
  const role = message.querySelector(".msg-role")
  if (role && !role.querySelector(".msg-aborted")) {
    const tag = document.createElement("span")
    tag.className = "msg-aborted"
    tag.textContent = "已中断"
    role.appendChild(tag)
  }
}

function markContextLinks(nodeId, context) {
  const involved = new Set((context?.tiers ?? []).map((tier) => tier.nodeId))
  involved.add(nodeId)
  state.activeLinks = new Set(
    state.graph.links
      .filter((link) => involved.has(link.from) && involved.has(link.to))
      .map((link) => link.id),
  )
  draw()
}

async function refresh() {
  state.graph = await api("/graph")
  state.nodesById = new Map(state.graph.nodes.map((n) => [n.id, n]))
  state.displayTitles = computeDisplayTitles()

  // 服务端固定布局优先（例如「标准化图结构」的结果），保证跨浏览器恢复。
  for (const node of state.graph.nodes) {
    const point = node.layouts?.["2d-canvas"]?.position
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) savedPositions.set(node.id, { x: point.x, y: point.y })
  }

  const alive = new Set(state.graph.nodes.map((n) => n.id))
  for (const [id, viewer] of contextWindows) if (!alive.has(id)) closeContextViewer(viewer)
  for (const [id, viewer] of notebookWindows) if (!alive.has(id)) closeNotebookViewer(viewer)
  for (const [id, viewer] of contextWindows) {
    const node = state.nodesById.get(id)
    renderContextViewerHeading(viewer, node)
    viewer.querySelector(".context-viewer-times").textContent = `创建 ${formatTime(node.createdAt)} · 最近活跃 ${node.opencodeSessionId ? formatTime(node.lastActiveAt) : "无会话"}`
    if (!viewer.settingsPending) {
      viewer.sessionSettings = { model: node.meta?.model ?? null, agent: node.meta?.agent ?? null, variant: node.meta?.variant ?? null }
      renderContextControls(viewer)
    }
  }
  for (const [id, viewer] of notebookWindows) {
    const node = state.nodesById.get(id)
    if (!node) continue
    renderNotebookTitle(viewer, node)
    renderPageBadges(viewer.querySelector(".context-viewer-pages"), id)
  }
  for (const id of [...state.positions.keys()]) if (!alive.has(id)) state.positions.delete(id)
  for (const id of [...state.anchors.keys()]) if (!alive.has(id)) state.anchors.delete(id)
  for (const id of [...state.pinned]) if (!alive.has(id)) state.pinned.delete(id)
  let removedPins = false
  for (const [id, position] of savedPositions) {
    if (!alive.has(id)) { savedPositions.delete(id); removedPins = true; continue }
    if (state.positions.has(id)) continue
    state.positions.set(id, { ...position })
    state.anchors.set(id, { ...position })
    state.pinned.add(id)
  }
  if (removedPins) savePinnedPositions()

  // 当前页面若已被删除，回退到「全部」
  if (state.activeWs && !state.graph.workspaces.some((w) => w.id === state.activeWs)) {
    state.activeWs = null
  }
  renderTabs()

  // 选中的对象若已消失（如节点被合并归档），清除选择
  if (state.selection) {
    const exists =
      state.selection.type === "node"
        ? state.graph.nodes.some((n) => n.id === state.selection.id)
        : state.graph.links.some((l) => l.id === state.selection.id)
    if (!exists) {
      state.selection = null
      hidePanel()
      closeLinkMenu()
    }
  }
  if (state.region && state.region.nodeIds.some((id) => !alive.has(id) || !isVisibleNode(id))) state.region = null

  layout(false)
  // 协作实例的槽位只在「尚无固定布局」时按模板相对位置摆放；
  // 一旦用户标准化或拖动过（已写入 savedPositions / 服务端 layouts），就尊重其位置，避免刷新后被覆盖。
  for (const [index, instance] of (state.graph.collaborations ?? []).entries()) {
    const known = instance.slots.find((slot) => savedPositions.has(slot.nodeId))
    const anchor = known ? savedPositions.get(known.nodeId) : { x: index * 900, y: 0 }
    const origin = known ?? instance.slots[0]
    if (!origin) continue
    for (const slot of instance.slots) {
      if (!slot.nodeId || savedPositions.has(slot.nodeId)) continue
      const p = { x: anchor.x + slot.x - origin.x, y: anchor.y + slot.y - origin.y }
      state.positions.set(slot.nodeId, p)
      state.anchors.set(slot.nodeId, { ...p })
      state.pinned.add(slot.nodeId)
    }
  }
  if (state.needFit) {
    fitView()
    state.needFit = false
  }
  draw()

  if (wsPanel.classList.contains("open")) renderWsPanel()

  const { nodes, workspaces, links } = state.graph
  const page = state.activeWs
    ? `页面「${workspaces.find((w) => w.id === state.activeWs)?.name ?? "?"}」 ` : "全部页面 "
  statusEl.textContent = `${page}· ${nodes.length} 节点 · ${workspaces.length} 页面 · ${links.length} 连接 · 拖动空白平移`
}

// ---------------- 节点面板 ----------------
async function openNodePanel(nodeId) {
  const detail = await api(`/nodes/${nodeId}`).catch(() => null)
  if (!detail) return
  const node = detail.node
  const others = state.graph.nodes.filter((n) => n.id !== node.id)
  const myLinks = detail.links ?? []
  const latestSummary = node.summaries.at(-1)

  // 笔记本是另一种节点：只读/写 Markdown，没有会话与上下文。
  if (node.kind === "notebook") {
    await openNotebookViewer(node.id)
    return
  }
  if (state.selection?.id !== nodeId) return
  if (!panel.classList.contains("open")) {
    try {
      const size = JSON.parse(localStorage.getItem("nodex.settingsSize"))
      if (Number.isFinite(size?.w) && Number.isFinite(size?.h)) {
        panel.style.width = clamp(size.w, 300, window.innerWidth - 16) + "px"
        panel.style.height = clamp(size.h, 220, window.innerHeight - 16) + "px"
      }
    } catch { /* Invalid local preference. */ }
  }
  document.getElementById("inspectorTitle").textContent = nodeDisplayTitle(node.id) || "节点"

  const wsChips = detail.workspaces.length
    ? detail.workspaces
        .map(
          (w) => `<span class="chip" style="border-color:${escapeHtml(w.color || "#6366f1")}">
            ${escapeHtml(w.name)}
            <button class="chip-x" data-leave="${escapeHtml(w.id)}" title="移出">×</button>
          </span>`,
        )
        .join("")
    : '<span class="muted">未加入任何工作区</span>'

  const linkChips = myLinks.length
    ? myLinks
        .map((l) => {
          const otherId = l.from === node.id ? l.to : l.from
          const dir = l.directed ? (l.from === node.id ? "→" : "←") : "—"
          return `<span class="chip" data-openlink="${escapeHtml(l.id)}" title="点击打开连线菜单">
            <span class="badge k-${escapeHtml(l.kind)}">${escapeHtml(l.kind)}</span>
            ${dir} ${escapeHtml(nodeTitle(otherId))}
          </span>`
        })
        .join("")
    : '<span class="muted">暂无连接</span>'

  const targetOptions = others
    .map((n) => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.title)}</option>`)
    .join("")

  // 思考强度：生效值 = 节点 meta.variant（NodeX 设置），否则 OpenCode 配置的 reasoningEffort；
  // 不再单列「默认」项——OpenCode 设了就显示它的值，没设就用 NodeX 的值。
  const thinkModel = node.meta?.model ?? state.model
  const thinkMatch = state.models.find((m) => m.providerID === thinkModel?.providerID && m.modelID === thinkModel?.modelID)
  const thinkVariants = thinkMatch?.variants ?? []
  const thinkDefault = thinkMatch?.defaultEffort ?? ""
  const thinkOverride = node.meta?.variant ?? ""
  const thinkEffective = thinkOverride || thinkDefault
  const thinkLevels = (thinkVariants.length ? thinkVariants : STANDARD_THINK_LEVELS).slice()
  if (thinkEffective && !thinkLevels.includes(thinkEffective)) thinkLevels.unshift(thinkEffective)
  const thinkSection = node.opencodeSessionId ? `
    <div class="section">
      <div class="section-title">思考强度</div>
      <div class="row">
        <select id="fThink">
          ${thinkLevels.map((level) => `<option value="${escapeHtml(level)}" ${thinkEffective === level ? "selected" : ""}>思考强度 · ${escapeHtml(level)}${thinkDefault === level ? "（OpenCode 默认）" : ""}</option>`).join("")}
        </select>
      </div>
      <div class="muted" id="thinkHint">${thinkVariants.length ? `模型声明：${thinkLevels.map(escapeHtml).join(" / ")}` : `模型未声明力度，可选标准档位：${thinkLevels.join(" / ")}`}${thinkDefault ? `；OpenCode 默认 ${escapeHtml(thinkDefault)}` : "；OpenCode 未配置默认强度"}</div>
    </div>` : ""

  panelBody.innerHTML = `
    <div class="node-settings-grid">
      <label class="field">标题
        <input id="fTitle" value="${escapeHtml(node.title)}" />
      </label>
      <label class="field">标签（逗号分隔）
        <input id="fTags" value="${escapeHtml((node.tags || []).join(", "))}" placeholder="React, 状态管理" />
      </label>
      <div class="row settings-actions">
        <button id="btnSave" class="primary">保存修改</button>
        <button id="btnAI" title="根据对话内容自动生成标题/标签/摘要">AI 生成</button>
      </div>
    </div>
    ${thinkSection}

    <div class="section">
      <div class="section-title">页面</div>
      <div class="chips">${wsChips}</div>
      <div class="row">
        <select id="wsSelect"><option value="">选择页面…</option>
          ${state.graph.workspaces.map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join("")}
        </select>
        <button id="btnJoinWs">加入</button>
        <button id="btnNewWs">新建</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">连接</div>
      <div class="chips">${linkChips}</div>
      <details>
        <summary class="section-title">+ 手动建立连接</summary>
        <div class="row">
          <select id="linkTarget"><option value="">选择目标节点…</option>${targetOptions}</select>
          <select id="linkKind" class="narrow">
            <option value="reference">引用</option>
            <option value="dependency">依赖</option>
            <option value="portal">Portal</option>
          </select>
          <button id="btnLink">建立</button>
        </div>
      </details>
    </div>

    <div class="section summary-section">
      <div class="section-title">摘要${latestSummary ? ` <span class="badge k-${escapeHtml(latestSummary.source || "ai")}">${escapeHtml(latestSummary.source || "ai")} v${latestSummary.version}</span>` : ""}</div>
      <textarea id="fSummary" placeholder="可手动填写摘要，供 Portal 与软加载使用">${escapeHtml(latestSummary?.text ?? "")}</textarea>
      <div class="row">
        <button id="btnSaveSummary">保存摘要</button>
        <button id="btnAISummary">AI 摘要</button>
      </div>
    </div>

    <div class="section files-section">
      <div class="section-title">产出文件（可点击预览）</div>
      <div class="row">
        <button id="btnFiles">刷新文件列表</button>
        <span id="filesInfo" class="muted"></span>
      </div>
      <div id="fileList"></div>
    </div>

    <div class="row end">
      <button id="btnDelete" class="danger">删除节点</button>
    </div>
    <div id="panelMsg" class="msg"></div>
  `

  const msg = panelBody.querySelector("#panelMsg")
  const setMsg = (text, isError = false) => {
    msg.textContent = text
    msg.className = "msg" + (isError ? " error" : "")
  }

  const busy = async (btn, label, fn) => {
    const original = btn.textContent
    btn.disabled = true
    btn.textContent = label
    try {
      await fn()
    } catch (error) {
      setMsg(error.message, true)
    } finally {
      btn.disabled = false
      btn.textContent = original
    }
  }

  panelBody.querySelector("#btnSave").onclick = (e) =>
    busy(e.target, "保存中…", async () => {
      const tags = panelBody.querySelector("#fTags").value
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
      await api(`/nodes/${node.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: panelBody.querySelector("#fTitle").value,
          tags,
        }),
      })
      setMsg("已保存")
      await refresh()
      await openNodePanel(node.id)
    })

  panelBody.querySelector("#btnAI").onclick = (e) =>
    busy(e.target, "生成中…", async () => {
      const res = await api(`/nodes/${node.id}/metadata`, { method: "POST", body: "{}" })
      setMsg(`AI 已生成：${res.generated?.title ?? ""}`)
      await refresh()
      await openNodePanel(node.id)
    })

  const thinkSelect = panelBody.querySelector("#fThink")
  if (thinkSelect) thinkSelect.addEventListener("change", async () => {
    const value = thinkSelect.value
    // 选中 OpenCode 默认档位时清空节点覆盖（继续跟随），否则写入显式强度。
    const next = value && value === thinkDefault ? null : value
    try {
      const updated = await api(`/nodes/${node.id}/session-settings`, {
        method: "PUT",
        body: JSON.stringify({ variant: next }),
      })
      if (state.nodesById.has(node.id) && updated?.meta) state.nodesById.get(node.id).meta = updated.meta
      const viewer = contextWindows.get(node.id)
      if (viewer) {
        viewer.sessionSettings = { ...(viewer.sessionSettings ?? {}), variant: updated?.meta?.variant ?? null }
        renderContextControls(viewer)
      }
      setMsg(next ? `思考强度已设为「${next}」` : "思考强度已恢复为 OpenCode 默认")
    } catch (error) {
      setMsg(error.message, true)
      thinkSelect.value = thinkOverride || thinkDefault
    }
  })

  panelBody.querySelectorAll("[data-leave]").forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation()
      await api(`/workspaces/${el.dataset.leave}/members`, {
        method: "POST",
        body: JSON.stringify({ nodeId: node.id, action: "leave" }),
      })
      await refresh()
      await openNodePanel(node.id)
    }
  })

  panelBody.querySelector("#btnJoinWs").onclick = (e) =>
    busy(e.target, "加入中…", async () => {
      const wsId = panelBody.querySelector("#wsSelect").value
      if (!wsId) throw new Error("请先选择工作区")
      await api(`/workspaces/${wsId}/members`, {
        method: "POST",
        body: JSON.stringify({ nodeId: node.id, action: "join" }),
      })
      setMsg("已加入工作区，将继承其 System Prompt")
      await refresh()
      await openNodePanel(node.id)
    })

  panelBody.querySelector("#btnNewWs").onclick = async () => {
    const name = prompt("新工作区名称")
    if (!name) return
    const systemPrompt = prompt("System Prompt（圈内节点共享）", "") ?? ""
    const ws = await api("/workspaces", {
      method: "POST",
      body: JSON.stringify({ name, systemPrompt }),
    })
    await api(`/workspaces/${ws.id}/members`, {
      method: "POST",
      body: JSON.stringify({ nodeId: node.id, action: "join" }),
    })
    await refresh()
    await openNodePanel(node.id)
  }

  panelBody.querySelector("#btnLink").onclick = (e) =>
    busy(e.target, "建立中…", async () => {
      const to = panelBody.querySelector("#linkTarget").value
      const kind = panelBody.querySelector("#linkKind").value
      if (!to) throw new Error("请先选择目标节点")
      await api("/links", {
        method: "POST",
        body: JSON.stringify({ from: node.id, to, kind }),
      })
      setMsg(kind === "portal" ? "已建立 Portal（自动附带摘要快照）" : "已建立连接")
      await refresh()
      await openNodePanel(node.id)
    })

  panelBody.querySelectorAll("[data-openlink]").forEach((el) => {
    el.onclick = () => select({ type: "link", id: el.dataset.openlink })
  })

  panelBody.querySelector("#btnSaveSummary").onclick = (e) =>
    busy(e.target, "保存中…", async () => {
      const text = panelBody.querySelector("#fSummary").value.trim()
      if (!text) throw new Error("摘要不能为空")
      await api(`/nodes/${node.id}/summary`, {
        method: "POST",
        body: JSON.stringify({ text }),
      })
      setMsg("摘要已保存")
      await refresh()
      await openNodePanel(node.id)
    })

  panelBody.querySelector("#btnAISummary").onclick = (e) =>
    busy(e.target, "生成中…", async () => {
      await api(`/nodes/${node.id}/summarize`, { method: "POST" })
      setMsg("AI 摘要已生成")
      await refresh()
      await openNodePanel(node.id)
    })

  // ---- 产出文件：列出会话中写入/访问过的文件，点击预览 ----
  const renderFiles = (payload, error) => {
    const list = panelBody.querySelector("#fileList")
    const info = panelBody.querySelector("#filesInfo")
    if (error) {
      info.textContent = error
      list.innerHTML = ""
      return
    }
    const files = payload.files ?? []
    info.textContent = files.length
      ? `共 ${files.length} 个 · 根目录 ${payload.root}`
      : `暂无文件（根目录 ${payload.root}）`
    list.innerHTML = files
      .map(
        (f) => `<div class="file-row ${f.exists ? "" : "missing"}" data-path="${escapeHtml(f.path)}" title="${escapeHtml(f.path)}">
          <span class="file-kind">${escapeHtml(f.kind)}</span>
          <span class="file-name">${escapeHtml(f.rel)}</span>
          <span class="file-size">${f.exists ? formatSize(f.size) : "不存在"}</span>
        </div>`,
      )
      .join("")
    list.querySelectorAll(".file-row").forEach((el) => {
      el.onclick = () => openFileViewer(el.dataset.path, node.id)
    })
  }
  const loadFiles = () =>
    api(`/nodes/${node.id}/files`)
      .then((p) => renderFiles(p))
      .catch((e) => renderFiles(null, e.message))
  panelBody.querySelector("#btnFiles").onclick = (e) => busy(e.target, "加载中…", loadFiles)
  loadFiles()

  panelBody.querySelector("#btnDelete").onclick = async () => {
    await deleteNodeWithConfirmation(node.id)
  }

  positionPanel()
}

function contextWindowSize() {
  let saved = null
  try { saved = JSON.parse(localStorage.getItem("nodex.contextSize")) } catch { /* Ignore invalid local preferences. */ }
  // Older snapshots also saved the former full-size default on first open.
  if (!saved?.manual) saved = null
  const defaultHeight = Math.min(window.innerHeight * (window.innerWidth < 720 ? .76 : .64), 520)
  return {
    w: Math.min(Math.max(340, Number(saved?.w) || 580), Math.max(280, window.innerWidth - 24)),
    h: Math.min(Math.max(280, Number(saved?.h) || defaultHeight), Math.max(240, window.innerHeight - 24)),
  }
}

function notebookWindowSize() {
  let saved = null
  try { saved = JSON.parse(localStorage.getItem("nodex.notebookSize")) } catch { /* Ignore invalid local preferences. */ }
  const fallback = contextWindowSize()
  return {
    w: Math.min(Math.max(300, Number(saved?.w) || Math.min(fallback.w, 520)), Math.max(280, window.innerWidth - 24)),
    h: Math.min(Math.max(240, Number(saved?.h) || fallback.h), Math.max(240, window.innerHeight - 24)),
  }
}

function managedWindows() {
  return [...contextWindows.values(), ...notebookWindows.values(), ...fileWindows.values()]
}

// 一键隐藏：像「前台窗口」一样整体收起，但新打开的窗口仍会显示；
// 常驻（📌）窗口不受隐藏影响，只能用 × 关闭。
let windowsHidden = false

function applyWindowVisibility() {
  document.getElementById("app").classList.toggle("windows-hidden", windowsHidden)
  for (const viewer of managedWindows()) {
    viewer.classList.toggle("window-hidden", !windowEffectivelyVisible(viewer))
  }
  scheduleDraw()
}

function updateWindowsToggleButton() {
  const button = document.getElementById("toggleWindows")
  if (!button) return
  button.textContent = windowsHidden ? "显示窗口" : "隐藏窗口"
  button.setAttribute("aria-pressed", String(windowsHidden))
}

function hideAllWindows() {
  windowsHidden = true
  for (const viewer of managedWindows()) viewer.windowHidden = !viewer.windowPersistent
  applyWindowVisibility()
  updateWindowsToggleButton()
}

function restoreAllWindows() {
  windowsHidden = false
  for (const viewer of managedWindows()) viewer.windowHidden = false
  applyWindowVisibility()
  updateWindowsToggleButton()
}

/** 关闭所有已打开的窗口（会话 / 笔记本 / 文件预览）。keepPersistent 时保留 📌 常驻窗口。 */
async function closeAllWindows({ keepPersistent = false } = {}) {
  let closed = 0
  for (const viewer of managedWindows()) {
    if (keepPersistent && viewer.windowPersistent) continue
    if (contextWindows.get(viewer.dataset.nodeId) === viewer) closeContextViewer(viewer)
    else if (notebookWindows.get(viewer.dataset.nodeId) === viewer) closeNotebookViewer(viewer)
    else if (fileWindows.get(viewer.dataset.path) === viewer) { if (!(await closeFileViewer(viewer))) continue }
    closed += 1
  }
  windowsHidden = false
  applyWindowVisibility()
  updateWindowsToggleButton()
  draw()
  return closed
}

/** 打开或聚焦窗口时让它重新可见（隐藏模式下点击节点也应显示）。 */
function showWindow(viewer) {
  if (!viewer.windowHidden) return
  viewer.windowHidden = false
  applyWindowVisibility()
}

function updatePersistButtons() {
  for (const el of managedWindows()) {
    const button = el.querySelector(".context-viewer-persist, .notebook-viewer-persist, .file-viewer-persist")
    if (!button) continue
    button.setAttribute("aria-pressed", String(Boolean(el.windowPersistent)))
    button.title = el.windowPersistent ? "取消常驻（会被一键隐藏）" : "常驻显示（不被一键隐藏）"
  }
}

function toggleWindowPersist(el) {
  el.windowPersistent = !el.windowPersistent
  if (windowsHidden) el.windowHidden = !el.windowPersistent
  applyWindowVisibility()
  updatePersistButtons()
}

/**
 * 台前调度下点击窗口内的交互控件（按钮 / 输入 / AI 摘要框等）不应把窗口抢到前台：
 * 否则点「关闭摘要」「关闭窗口」会先被换到主区、点击落空导致操作失效。
 */
function isWindowControlTarget(target) {
  if (!target?.closest) return false
  return Boolean(target.closest(
    "button, a, input, textarea, select, label, summary, [contenteditable='true'], " +
    ".nb-summary, .nb-ai-menu, .nb-sel-menu, .context-outline, .context-files-popover, " +
    ".context-view-popover, .context-model-popover, .context-tui-popover, .context-command-popover, .context-think-popover",
  ))
}

/**
 * 是否跳过「切到前台」。侧栏缩略窗（台前调度）里点任何控件都不应换台，
 * 否则点关闭 / 关闭摘要会先被换到主区导致点击落空；普通窗口只豁免标题栏按钮。
 */
function shouldSkipWindowFocus(viewer, target) {
  if (viewer.classList.contains("tile-docked")) return isWindowControlTarget(target)
  return Boolean(target?.closest?.(".inspector-bar button, .inspector-bar input"))
}

function focusContextViewer(viewer) {
  if (viewer.dataset.dragging === "true") return
  if (tiledWindowPositions && tileLayout?.rects && tileLayout.mode === "stage") {
    if (tileActiveViewer !== viewer) {
      tileActiveViewer = viewer
      retileContextWindows()
    }
    return
  }
  if (viewer.windowPinned) { viewer.style.zIndex = "45"; return }
  viewer.style.zIndex = tiledWindowPositions ? "30" : String(++windowLayer)
}

function updatePinButtons() {
  for (const el of managedWindows()) {
    const button = el.querySelector(".context-viewer-pin, .notebook-viewer-pin, .file-viewer-pin")
    if (!button) continue
    button.setAttribute("aria-pressed", String(Boolean(el.windowPinned)))
    button.title = el.windowPinned ? "取消置顶" : "置顶显示"
  }
  saveWindowSessionSoon()
}

function toggleWindowPin(el) {
  el.windowPinned = !el.windowPinned
  if (el.windowPinned) {
    if (tiledWindowPositions?.has(el)) {
      const previous = tiledWindowPositions.get(el)
      Object.assign(el.style, previous.style)
      el.classList.toggle("maximized", previous.maximized)
      tiledWindowPositions.delete(el)
      el.dataset.tiled = ""
      retileContextWindows()
    }
    el.style.zIndex = "45"
  } else if (tiledWindowPositions) {
    tiledWindowPositions.set(el, {
      style: { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height, zIndex: "" },
      maximized: el.classList.contains("maximized"),
    })
    retileContextWindows()
  } else {
    focusContextViewer(el)
  }
  updatePinButtons()
}

function updateTilingButtons() {
  for (const el of managedWindows()) {
    const button = el.querySelector(".context-viewer-tile, .notebook-viewer-tile, .file-viewer-tile")
    if (!button) continue
    button.title = tiledWindowPositions ? "还原窗口布局" : "分屏铺满"
    button.setAttribute("aria-pressed", String(Boolean(tiledWindowPositions)))
  }
  saveWindowSessionSoon()
}

function tileRowCounts(count, width) {
  if (count <= 1) return [1]
  if (width < 720) return Array.from({ length: count }, () => 1)
  const cols = count <= 4 ? 2 : 3
  const rows = []
  for (let left = count; left > 0; left -= cols) rows.push(Math.min(cols, left))
  return rows
}

function buildGridTileLayout(viewers, area) {
  const counts = tileRowCounts(viewers.length, area.width)
  let index = 0
  const rows = counts.map((size) => {
    const items = viewers.slice(index, index + size)
    index += size
    return { items, colRatios: items.map(() => 1 / items.length) }
  })
  return { area, mode: "grid", rows, rowRatios: rows.map(() => 1 / rows.length) }
}

// 台前调度：当前窗口占主区，其余窗口在左侧堆叠成缩略条，点选切换前台。
// 主区与侧栏之间、侧栏各项之间都有分隔条，可拖动调整大小。
// 侧栏最多同时完整显示 4 个缩略窗；更多时保持该高度并允许滚动。
const DOCK_MIN_ITEMS = 4

function buildDockTileLayout(viewers, area) {
  const active = viewers.includes(tileActiveViewer) ? tileActiveViewer : viewers[0]
  const others = viewers.filter((viewer) => viewer !== active)
  const layout = { area, mode: "stage", active, others, rects: [] }
  if (!others.length) return layout
  layout.dockWidthRatio = clamp(tileDock.widthRatio || 0.3, 0.15, 0.6)
  layout.scrollable = others.length > DOCK_MIN_ITEMS
  if (tileDock.scrollFor !== others.length) {
    tileDock.scroll = 0
    tileDock.scrollFor = others.length
  }
  if (!layout.scrollable && (!Array.isArray(tileDock.itemRatios) || tileDock.itemRatios.length !== others.length)) {
    tileDock.itemRatios = others.map(() => 1 / others.length)
  }
  return layout
}

/** 由台前调度比例计算每个窗口的几何；每次拖动或切换前台都重新计算。 */
function dockTileRects(layout) {
  const { area, active, others } = layout
  // 与平铺一致：窗口之间不留空隙（分隔条用 8px 透明命中区叠加在边界上）。
  const gap = 0
  if (!others.length) return [{ viewer: active, left: area.left, top: area.top, width: area.width, height: area.height, role: "main" }]
  const dockWidth = Math.round(area.width * layout.dockWidthRatio)
  const mainWidth = Math.max(160, area.width - dockWidth - gap)
  const rects = [{ viewer: active, left: area.left + dockWidth + gap, top: area.top, width: mainWidth, height: area.height, role: "main" }]
  if (layout.scrollable) {
    // 固定每个缩略窗高度为「4 个窗口」时的尺寸，内容超高时整体滚动。
    const itemHeight = (area.height - gap * (DOCK_MIN_ITEMS - 1)) / DOCK_MIN_ITEMS
    const contentHeight = itemHeight * others.length + gap * (others.length - 1)
    const maxScroll = Math.max(0, contentHeight - area.height)
    tileDock.scroll = clamp(tileDock.scroll || 0, 0, maxScroll)
    layout.maxScroll = maxScroll
    let top = area.top - tileDock.scroll
    others.forEach((viewer) => {
      rects.push({ viewer, left: area.left, top: Math.round(top), width: dockWidth, height: Math.round(itemHeight), role: "dock" })
      top += itemHeight + gap
    })
    return rects
  }
  const totalHeight = area.height - gap * (others.length - 1)
  let top = area.top
  others.forEach((viewer, index) => {
    const height = totalHeight * tileDock.itemRatios[index]
    rects.push({ viewer, left: area.left, top: Math.round(top), width: dockWidth, height: Math.round(height), role: "dock" })
    top += height + gap
  })
  return rects
}

/** 内容区顶部起点与四周外边距：与文件侧栏（top 60 / left 12 / bottom 12）保持一致，便于对齐。 */
const CONTENT_TOP = 60
const CONTENT_GAP = 12

function tileArea() {
  const panel = document.getElementById("fsPanel")
  let left = CONTENT_GAP
  if (panel && !panel.hidden && panel.dataset.mode === "drawer") {
    left = Math.round(panel.getBoundingClientRect().right + CONTENT_GAP)
  }
  return {
    left,
    top: CONTENT_TOP,
    width: Math.max(240, window.innerWidth - left - CONTENT_GAP),
    height: Math.max(200, window.innerHeight - CONTENT_TOP - CONTENT_GAP),
  }
}

/** 最大化窗口直接铺满可用内容区（与平铺边界、文件侧栏顶/底对齐，不再额外内缩）。 */
function maximizedArea() {
  return tileArea()
}

function updateMaximizedVars() {
  const a = maximizedArea()
  const app = document.getElementById("app")
  app.style.setProperty("--win-max-left", a.left + "px")
  app.style.setProperty("--win-max-top", a.top + "px")
  app.style.setProperty("--win-max-width", a.width + "px")
  app.style.setProperty("--win-max-height", a.height + "px")
}

function buildTileLayout(viewers) {
  const area = tileArea()
  if (tileMode === "stage") return buildDockTileLayout(viewers, area)
  return buildGridTileLayout(viewers, area)
}

function clearTileDividers() {
  for (const divider of tileDividers) divider.remove()
  tileDividers = []
}

function createTileDividers() {
  clearTileDividers()
  if (!tileLayout) return
  const app = document.getElementById("app")
  if (tileLayout.mode === "stage") {
    if (!tileLayout.others?.length) return
    const divider = document.createElement("div")
    divider.className = "tile-divider tile-divider-v"
    app.append(divider)
    attachTileDividerDrag(divider, "dockW")
    tileLayout.dockDivider = divider
    tileDividers.push(divider)
    tileLayout.itemDividers = []
    for (let i = 0; i < (tileLayout.scrollable ? 0 : tileLayout.others.length - 1); i++) {
      const itemDivider = document.createElement("div")
      itemDivider.className = "tile-divider tile-divider-h"
      app.append(itemDivider)
      attachTileDividerDrag(itemDivider, "dockItem", i)
      tileLayout.itemDividers.push(itemDivider)
      tileDividers.push(itemDivider)
    }
    return
  }
  if (tileLayout.mode !== "grid") return
  tileLayout.rows.forEach((row, r) => {
    if (r < tileLayout.rows.length - 1) {
      const divider = document.createElement("div")
      divider.className = "tile-divider tile-divider-h"
      app.append(divider)
      attachTileDividerDrag(divider, "row", r)
      row.hDivider = divider
      tileDividers.push(divider)
    }
    row.vDividers = []
    for (let c = 0; c < row.items.length - 1; c++) {
      const divider = document.createElement("div")
      divider.className = "tile-divider tile-divider-v"
      app.append(divider)
      attachTileDividerDrag(divider, "col", r, c)
      row.vDividers.push(divider)
      tileDividers.push(divider)
    }
  })
}

/** 台前调度侧栏缩略窗：默认折叠会话输入框，并按可用宽度保留标题栏右侧按钮。 */
function applyDockState(viewer, docked) {
  viewer.classList.toggle("tile-docked", docked)
  const collapseBtn = viewer.querySelector(".context-viewer-collapse")
  if (collapseBtn) {
    if (docked) {
      if (viewer.dockCollapseSaved === undefined) {
        viewer.dockCollapseSaved = Boolean(viewer.composeCollapsed)
        viewer.dockCollapsePrev = Boolean(viewer.composeCollapsed)
      }
      if (!viewer.composeCollapsed) setComposeCollapsed(viewer, true)
    } else if (viewer.dockCollapseSaved !== undefined) {
      if (!viewer.dockCollapsePrev && viewer.composeCollapsed) setComposeCollapsed(viewer, false)
      delete viewer.dockCollapseSaved
      delete viewer.dockCollapsePrev
    }
  }
  applyDockTitleButtons(viewer, docked)
}

/**
 * 台前调度侧栏宽度不足时，从左侧开始折叠标题栏按钮，优先保留最右侧的
 * 关闭 / 最大化 / 分屏等操作。
 */
function applyDockTitleButtons(viewer, docked) {
  const bar = viewer.querySelector(".inspector-bar")
  if (!bar) return
  const buttons = [...bar.children].filter((el) => el.matches("button, input[type=color]"))
  if (!buttons.length) return
  if (!docked) {
    for (const button of buttons) button.classList.remove("dock-hidden")
    return
  }
  // 先全部显示再测量，否则 display:none 的按钮宽度为 0。
  for (const button of buttons) button.classList.remove("dock-hidden")
  const titleBlock = bar.querySelector(".context-viewer-title-block")
  const barWidth = bar.clientWidth
  const titleReserve = titleBlock
    ? clamp(titleBlock.offsetWidth, Math.min(barWidth * 0.4, 72), barWidth * 0.5)
    : 0
  let budget = barWidth - titleReserve - 8
  const keep = new Set()
  for (let i = buttons.length - 1; i >= 0; i--) {
    const button = buttons[i]
    const width = button.offsetWidth + 4
    if (budget - width >= 0) { keep.add(button); budget -= width }
  }
  for (const button of buttons) button.classList.toggle("dock-hidden", !keep.has(button))
}


/** 台前调度侧栏的裁剪容器：窗口多于 4 个时用它承载并滚动缩略窗。 */
function ensureDockClip() {
  let clip = document.getElementById("tileDockClip")
  if (!clip) {
    clip = document.createElement("div")
    clip.id = "tileDockClip"
    clip.innerHTML = '<div id="tileDockScrollbar"></div>'
    clip.addEventListener("wheel", onDockWheel, { passive: false })
    document.getElementById("app").append(clip)
    const bar = clip.querySelector("#tileDockScrollbar")
    bar.addEventListener("pointerdown", (event) => {
      if (!tiledWindowPositions || tileLayout?.mode !== "stage" || !tileLayout.scrollable) return
      const area = tileLayout.area
      const maxScroll = tileLayout.maxScroll || 0
      if (maxScroll <= 0) return
      event.preventDefault()
      event.stopPropagation()
      const rect = bar.getBoundingClientRect()
      const usable = Math.max(1, area.height - rect.height)
      const startY = event.clientY
      const startScroll = tileDock.scroll || 0
      bar.setPointerCapture(event.pointerId)
      const move = (e) => {
        tileDock.scroll = clamp(startScroll + ((e.clientY - startY) / usable) * maxScroll, 0, maxScroll)
        applyTileLayout()
      }
      const stop = () => {
        bar.removeEventListener("pointermove", move)
        bar.removeEventListener("pointerup", stop)
        bar.removeEventListener("pointercancel", stop)
      }
      bar.addEventListener("pointermove", move)
      bar.addEventListener("pointerup", stop)
      bar.addEventListener("pointercancel", stop)
    })
  }
  return clip
}

function clearDockClip() {
  const clip = document.getElementById("tileDockClip")
  if (!clip) return
  const app = document.getElementById("app")
  for (const viewer of [...clip.children]) {
    if (viewer.id === "tileDockScrollbar") continue
    app.append(viewer)
  }
  clip.hidden = true
}

function onDockWheel(event) {
  if (!tiledWindowPositions || tileLayout?.mode !== "stage" || !tileLayout.scrollable || event.ctrlKey) return
  const maxScroll = tileLayout.maxScroll || 0
  if (maxScroll <= 0) return
  event.preventDefault()
  tileDock.scroll = clamp((tileDock.scroll || 0) + event.deltaY, 0, maxScroll)
  applyTileLayout()
}

/** 把侧栏缩略窗放进裁剪容器并按滚动偏移摆位。 */
function applyStageDockClip(layout) {
  const app = document.getElementById("app")
  const dockRects = layout.rects.filter((rect) => rect.role === "dock")
  const main = layout.rects.find((rect) => rect.role === "main")
  // 侧栏窗口不超过裁剪阈值时不需要滚动：所有窗口都留在 #app，完全避免跨容器搬动 DOM，
  // 从而根除交换瞬间的重绘闪帧（对平铺窗口关闭 backdrop-filter 是第二道保险）。
  if (!layout.scrollable) {
    ensureDockClip()
    clearDockClip()
    if (main?.viewer && main.viewer.parentElement !== app) app.append(main.viewer)
    return
  }
  const clip = ensureDockClip()
  // 只有滚动列表才需要裁剪容器：此时窗口在 app 与裁剪容器之间搬动，
  // 重新插入 DOM 会重启入场动画，搬动期间临时关掉入场动画。
  const reparent = Boolean(main?.viewer && main.viewer.parentElement === clip) ||
    dockRects.some((rect) => rect.viewer.parentElement !== clip)
  if (reparent) app.classList.add("window-laying")
  if (main?.viewer && main.viewer.parentElement === clip) app.append(main.viewer)
  clip.hidden = false
  clip.style.left = layout.area.left + "px"
  clip.style.top = layout.area.top + "px"
  clip.style.width = Math.round(layout.area.width * layout.dockWidthRatio) + "px"
  clip.style.height = layout.area.height + "px"
  clip.classList.toggle("dock-scrollable", Boolean(layout.scrollable))
  for (const rect of dockRects) if (rect.viewer.parentElement !== clip) clip.append(rect.viewer)
  updateDockScrollbar(clip, layout)
  if (reparent) requestAnimationFrame(() => requestAnimationFrame(() => app.classList.remove("window-laying")))
}

/** 侧栏滚动条：可见、可拖动、可按住滚动。 */
function updateDockScrollbar(clip, layout) {
  const bar = clip.querySelector("#tileDockScrollbar")
  if (!bar) return
  const track = layout.area.height
  const maxScroll = layout.maxScroll || 0
  if (!layout.scrollable || maxScroll <= 0) {
    bar.style.display = "none"
    bar.dataset.active = ""
    return
  }
  const content = track + maxScroll
  const thumbH = Math.max(28, Math.round(track * track / content))
  bar.style.display = "block"
  bar.style.height = thumbH + "px"
  bar.style.top = Math.round((tileDock.scroll / maxScroll) * (track - thumbH)) + "px"
  bar.dataset.active = "1"
}

function applyTileLayout() {
  if (!tileLayout) return
  if (tileLayout.rects) {
    if (tileLayout.mode === "stage") {
      tileLayout.rects = dockTileRects(tileLayout)
      applyStageDockClip(tileLayout)
    } else {
      clearDockClip()
    }
    const docked = new Set(tileLayout.mode === "stage" ? (tileLayout.others ?? []) : [])
    for (const rect of tileLayout.rects) {
      const viewer = rect.viewer
      if (!viewer?.isConnected) continue
      viewer.style.right = "auto"
      if (rect.role === "dock" && viewer.parentElement?.id === "tileDockClip") {
        // 仅在可滚动裁剪容器内时才用相对容器坐标。
        viewer.style.left = "0px"
        viewer.style.top = Math.round(rect.top - tileLayout.area.top) + "px"
      } else {
        if (viewer.parentElement !== document.getElementById("app")) document.getElementById("app").append(viewer)
        viewer.style.left = Math.round(rect.left) + "px"
        viewer.style.top = Math.round(rect.top) + "px"
      }
      viewer.style.width = Math.round(rect.width) + "px"
      viewer.style.height = Math.round(rect.height) + "px"
      viewer.style.zIndex = viewer === tileLayout.active ? "32" : "30"
    }
    // 尺寸写入后再切换侧栏状态，保证标题栏按钮按真实宽度折叠。
    for (const viewer of managedWindows()) applyDockState(viewer, docked.has(viewer))
    if (tileLayout.mode === "stage") positionDockDividers(tileLayout)
    return
  }
  const { area, rows, rowRatios } = tileLayout
  let top = area.top
  rows.forEach((row, r) => {
    const height = rowRatios[r] * area.height
    let left = area.left
    row.items.forEach((viewer, c) => {
      const width = row.colRatios[c] * area.width
      viewer.style.left = Math.round(left) + "px"
      viewer.style.top = Math.round(top) + "px"
      viewer.style.width = Math.round(width) + "px"
      viewer.style.height = Math.round(height) + "px"
      viewer.style.zIndex = "30"
      left += width
    })
    if (row.hDivider) {
      row.hDivider.style.left = area.left + "px"
      row.hDivider.style.top = Math.round(top + height) + "px"
      row.hDivider.style.width = area.width + "px"
    }
    row.vDividers?.forEach((divider, c) => {
      const x = area.left + row.colRatios.slice(0, c + 1).reduce((sum, value) => sum + value, 0) * area.width
      divider.style.left = Math.round(x) + "px"
      divider.style.top = Math.round(top) + "px"
      divider.style.height = Math.round(height) + "px"
    })
    top += height
  })
}

/** 台前调度分隔条位置：竖条在主区左缘，横条在侧栏各项之间。 */
function positionDockDividers(layout) {
  const { area, others } = layout
  if (!others.length) return
  const gap = 0
  const dockWidth = Math.round(area.width * layout.dockWidthRatio)
  if (layout.dockDivider) {
    layout.dockDivider.style.left = Math.round(area.left + dockWidth + gap / 2) + "px"
    layout.dockDivider.style.top = area.top + "px"
    layout.dockDivider.style.height = area.height + "px"
  }
  if (layout.scrollable) return
  const totalHeight = area.height - gap * (others.length - 1)
  let top = area.top
  others.forEach((viewer, index) => {
    const height = totalHeight * tileDock.itemRatios[index]
    if (index < others.length - 1 && layout.itemDividers?.[index]) {
      layout.itemDividers[index].style.left = area.left + "px"
      layout.itemDividers[index].style.top = Math.round(top + height + gap / 2) + "px"
      layout.itemDividers[index].style.width = dockWidth + "px"
    }
    top += height + gap
  })
}

function attachTileDividerDrag(divider, kind, r, c) {
  divider.addEventListener("pointerdown", (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!tileLayout) return
    const area = tileLayout.area
    const startX = event.clientX, startY = event.clientY
    divider.classList.add("dragging")
    divider.setPointerCapture(event.pointerId)
    let move
    if (kind === "dockW") {
      const startRatio = tileLayout.dockWidthRatio
      move = (e) => {
        tileDock.widthRatio = clamp(startRatio + (e.clientX - startX) / area.width, 0.15, 0.6)
        tileLayout.dockWidthRatio = tileDock.widthRatio
        applyTileLayout()
      }
    } else if (kind === "dockItem") {
      const startRatios = [...tileDock.itemRatios]
      const totalHeight = area.height
      move = (e) => {
        const min = 0.06
        const total = startRatios[r] + startRatios[r + 1]
        const next = clamp(startRatios[r] + (e.clientY - startY) / totalHeight, min, total - min)
        tileDock.itemRatios[r] = next
        tileDock.itemRatios[r + 1] = total - next
        applyTileLayout()
      }
    } else {
      const row = tileLayout.rows[r]
      const startRowRatios = [...tileLayout.rowRatios]
      const startColRatios = kind === "col" ? [...row.colRatios] : null
      move = (e) => {
        const min = 0.08
        if (kind === "row") {
          const total = startRowRatios[r] + startRowRatios[r + 1]
          const next = clamp(startRowRatios[r] + (e.clientY - startY) / area.height, min, total - min)
          tileLayout.rowRatios[r] = next
          tileLayout.rowRatios[r + 1] = total - next
        } else {
          const total = startColRatios[c] + startColRatios[c + 1]
          const next = clamp(startColRatios[c] + (e.clientX - startX) / area.width, min, total - min)
          row.colRatios[c] = next
          row.colRatios[c + 1] = total - next
        }
        applyTileLayout()
      }
    }
    const stop = () => {
      divider.classList.remove("dragging")
      divider.removeEventListener("pointermove", move)
      divider.removeEventListener("pointerup", stop)
      divider.removeEventListener("pointercancel", stop)
    }
    divider.addEventListener("pointermove", move)
    divider.addEventListener("pointerup", stop)
    divider.addEventListener("pointercancel", stop)
  })
}

function retileContextWindows() {
  if (!tiledWindowPositions) return
  const present = managedWindows().filter((viewer) => !viewer.windowPinned && !viewer.windowUntiled && windowEffectivelyVisible(viewer))
  if (!present.length) {
    tiledWindowPositions = null
    tileOrder = []
    tileLayout = null
    clearTileDividers()
    clearDockClip()
    updateTilingButtons()
    return
  }
  tileOrder = tileOrder.filter((viewer) => present.includes(viewer))
  for (const viewer of present) if (!tileOrder.includes(viewer)) tileOrder.push(viewer)
  const viewers = tileOrder
  if (!viewers.includes(tileActiveViewer)) {
    tileActiveViewer = viewers.reduce((best, viewer) => {
      const z = Number(viewer.style.zIndex) || 0
      return z >= best.z ? { z, viewer } : best
    }, { z: -1, viewer: viewers[0] }).viewer
  }
  viewers.forEach((viewer) => {
    viewer.classList.remove("maximized")
    viewer.dataset.tiled = "true"
  })
  tileLayout = buildTileLayout(viewers)
  createTileDividers()
  applyTileLayout()
  updateTilingButtons()
  scheduleDraw()
}

function animateWindowLayout(run) {
  // 台前调度交换不再做位移动画：过渡期间窗口未完全覆盖会漏出画布，改为瞬时切换。
  run()
}

function tileContextWindows() {
  if (tiledWindowPositions) {
    animateWindowLayout(() => {
      for (const [viewer, previous] of tiledWindowPositions) {
        if (!viewer.isConnected) continue
        Object.assign(viewer.style, previous.style)
        viewer.classList.toggle("maximized", previous.maximized)
        applyDockState(viewer, false)
        viewer.dataset.tiled = ""
      }
      tiledWindowPositions = null
      tileOrder = []
      tileLayout = null
      tileActiveViewer = null
      clearTileDividers()
      clearDockClip()
      updateTilingButtons()
    })
    return
  }
  const viewers = managedWindows().filter((viewer) => !viewer.windowPinned && windowEffectivelyVisible(viewer))
  if (!viewers.length) return
  for (const viewer of managedWindows()) viewer.windowUntiled = false
  tileDock = { widthRatio: 0.3, itemRatios: [], scroll: 0, scrollFor: 0 }
  animateWindowLayout(() => {
    tileOrder = [...viewers]
    tileActiveViewer = viewers.reduce((best, viewer) => {
      const z = Number(viewer.style.zIndex) || 0
      return z >= best.z ? { z, viewer } : best
    }, { z: -1, viewer: viewers[0] }).viewer
    tiledWindowPositions = new Map(viewers.map((viewer) => [viewer, {
      style: { left: viewer.style.left, top: viewer.style.top, width: viewer.style.width, height: viewer.style.height, zIndex: viewer.style.zIndex },
      maximized: viewer.classList.contains("maximized"),
    }]))
    retileContextWindows()
  })
}

/** 平铺视图下拖动窗口标题栏：拖到另一个窗口上松开即交换平铺位置。 */
function startTileDrag(viewer, event) {
  if (!tiledWindowPositions || !tileOrder.includes(viewer)) return
  event.preventDefault()
  const app = document.getElementById("app")
  const rect = viewer.getBoundingClientRect()
  viewer.style.right = "auto"
  const offsetX = event.clientX - rect.left
  const offsetY = event.clientY - rect.top
  const others = tileOrder.filter((item) => item !== viewer && item.isConnected)
  const placeholder = document.createElement("div")
  placeholder.className = "tile-drop-target"
  placeholder.hidden = true
  app.append(placeholder)
  viewer.dataset.dragging = "true"
  viewer.style.zIndex = "60"
  let target = null
  const startLeft = Math.round(rect.left)
  const startTop = Math.round(rect.top)
  let moved = false
  const move = (e) => {
    viewer.style.left = Math.round(e.clientX - offsetX) + "px"
    viewer.style.top = Math.round(e.clientY - offsetY) + "px"
    if (Math.hypot(e.clientX - offsetX - startLeft, e.clientY - offsetY - startTop) > 24) moved = true
    let hit = null
    for (const other of others) {
      const r = other.getBoundingClientRect()
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) { hit = other; break }
    }
    target = hit
    if (hit) {
      const r = hit.getBoundingClientRect()
      placeholder.hidden = false
      placeholder.style.left = r.left + "px"
      placeholder.style.top = r.top + "px"
      placeholder.style.width = r.width + "px"
      placeholder.style.height = r.height + "px"
    } else {
      placeholder.hidden = true
    }
  }
  const finish = () => {
    window.removeEventListener("pointermove", move)
    window.removeEventListener("pointerup", finish)
    window.removeEventListener("pointercancel", finish)
    placeholder.remove()
    delete viewer.dataset.dragging
    if (target && target !== viewer) {
      const from = tileOrder.indexOf(viewer)
      const to = tileOrder.indexOf(target)
      if (from >= 0 && to >= 0) {
        tileOrder.splice(from, 1)
        tileOrder.splice(to, 0, viewer)
      }
      retileContextWindows()
      return
    }
    if (moved) {
      // 平铺下拖到空白处且没有交换目标：降级为常规浮窗，保留拖到的位置
      const previous = tiledWindowPositions.get(viewer)
      tiledWindowPositions.delete(viewer)
      tileOrder = tileOrder.filter((item) => item !== viewer)
      viewer.windowUntiled = true
      viewer.dataset.tiled = ""
      viewer.classList.remove("maximized")
      if (previous?.style?.width) viewer.style.width = previous.style.width
      if (previous?.style?.height) viewer.style.height = previous.style.height
      retileContextWindows()
      viewer.style.zIndex = String(++windowLayer)
      statusEl.textContent = "已从平铺改为常规窗口"
      saveWindowSessionSoon()
      return
    }
    retileContextWindows()
  }
  window.addEventListener("pointermove", move)
  window.addEventListener("pointerup", finish)
  window.addEventListener("pointercancel", finish)
}

function positionContextViewer(viewer, nodeId) {  const rect = viewer.getBoundingClientRect()
  const w = rect.width, h = rect.height
  const position = state.positions.get(nodeId)
  const center = position ? screenOf(position.x, position.y) : { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  const nodeR = position ? radiusOf(nodeId) * state.camera.zoom : 0
  const candidates = [
    { x: center.x + nodeR + 24, y: center.y - h / 2 },
    { x: center.x - nodeR - w - 24, y: center.y - h / 2 },
    { x: center.x - w / 2, y: center.y + nodeR + 24 },
    { x: center.x - w / 2, y: center.y - nodeR - h - 24 },
  ]
  const obstacles = [...contextWindows.values()].filter((other) => other !== viewer)
    .concat([panel, ...notebookWindows.values(), ...fileWindows.values(), document.getElementById("templatePanel"), document.getElementById("wsPanel")])
    .filter((el) => el.classList.contains("open"))
    .map((el) => el.getBoundingClientRect())
  const placed = candidates.map(({ x, y }) => {
    const left = clamp(x, 8, Math.max(8, window.innerWidth - w - 8))
    const top = clamp(y, 8, Math.max(8, window.innerHeight - h - 8))
    const overlap = obstacles.reduce((sum, other) => sum +
      Math.max(0, Math.min(left + w, other.right) - Math.max(left, other.left)) *
      Math.max(0, Math.min(top + h, other.bottom) - Math.max(top, other.top)), 0)
    return { left, top, score: overlap + Math.hypot(left - x, top - y) * 100 }
  }).sort((a, b) => a.score - b.score)[0]
  viewer.style.left = placed.left + "px"
  viewer.style.top = placed.top + "px"
}

function setComposeCollapsed(viewer, collapsed, { focus = false } = {}) {
  viewer.composeCollapsed = collapsed
  viewer.classList.toggle("compose-collapsed", collapsed)
  const button = viewer.querySelector(".context-viewer-collapse")
  button.textContent = collapsed ? "⌃" : "⌄"
  button.title = collapsed ? "展开输入框" : "折叠输入框"
  button.setAttribute("aria-pressed", String(collapsed))
  if (!collapsed && focus) viewer.querySelector(".context-prompt").focus()
}

function autoGrowPrompt(input) {
  if (!input) return
  const max = Math.max(66, Math.round(window.innerHeight * 0.24))
  input.style.height = "auto"
  const next = Math.min(input.scrollHeight, max)
  input.style.height = next + "px"
  input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden"
}

// ---------------- 输入暂存 ----------------
function renderStaged(viewer) {
  const container = viewer.querySelector(".context-staged")
  if (!container) return
  const items = viewer.staged ?? []
  container.hidden = !items.length
  container.innerHTML = items.map((item) => {
    const label = item.text.replace(/\s+/g, " ").slice(0, 12)
    const title = item.text.length > 600 ? `${item.text.slice(0, 600)}…` : item.text
    return `<span class="context-staged-chip" data-id="${escapeHtml(item.id)}"><button type="button" class="context-staged-restore" title="${escapeHtml(title)}">${escapeHtml(label)}</button><button type="button" class="context-staged-close" title="移除暂存" aria-label="移除暂存">×</button></span>`
  }).join("")
}

function stagePromptText(viewer) {
  const input = viewer.querySelector(".context-prompt")
  const text = input.value.trim()
  if (!text) return
  viewer.staged = viewer.staged ?? []
  viewer.staged.push({ id: `st_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, text })
  input.value = ""
  autoGrowPrompt(input)
  renderStaged(viewer)
  input.focus()
}

function restoreStaged(viewer, id) {
  const items = viewer.staged ?? []
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return
  const [item] = items.splice(index, 1)
  const input = viewer.querySelector(".context-prompt")
  input.value = input.value.trim() ? `${input.value.replace(/\s+$/, "")}\n${item.text}` : item.text
  autoGrowPrompt(input)
  renderStaged(viewer)
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}

function removeStaged(viewer, id) {
  viewer.staged = (viewer.staged ?? []).filter((item) => item.id !== id)
  renderStaged(viewer)
}

/** 折叠态填入内容前先展开：隐藏的 textarea 无法聚焦，会导致一直保持折叠。 */
function ensureComposeOpen(viewer) {
  if (viewer.composeCollapsed) setComposeCollapsed(viewer, false)
}

/** 把文本追加到会话输入框：自动展开、增高并聚焦到末尾。 */
function fillContextPrompt(viewer, text) {
  ensureComposeOpen(viewer)
  const input = viewer.querySelector(".context-prompt")
  input.value += text
  autoGrowPrompt(input)
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  return input
}

/** 覆盖式填入会话输入框：同样自动展开与增高。 */
function setContextPrompt(viewer, text) {
  ensureComposeOpen(viewer)
  const input = viewer.querySelector(".context-prompt")
  input.value = text
  autoGrowPrompt(input)
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  return input
}

function renderContextControls(viewer) {
  const model = viewer.sessionSettings?.model ?? state.model
  const match = state.models.find((item) => item.providerID === model?.providerID && item.modelID === model?.modelID)
  const modelButton = viewer.querySelector(".context-model-button")
  modelButton.textContent = model ? `模型 · ${match?.name || model.modelID}` : "OpenCode 默认"
  modelButton.title = model ? `${model.providerID}/${model.modelID} · 切换当前会话模型` : "切换当前会话模型"
  modelButton.disabled = !state.models.length
  const agent = viewer.sessionSettings?.agent ?? state.defaultAgent
  viewer.querySelectorAll(".context-mode button").forEach((button) => {
    button.disabled = !state.agents.some((item) => item.name === button.dataset.agent)
    button.classList.toggle("active", button.dataset.agent === agent)
    button.setAttribute("aria-pressed", button.dataset.agent === agent ? "true" : "false")
  })
  renderThinkButton(viewer, match)
}

/** 标准推理强度档位：模型未在 OpenCode 配置声明 variants 时，窗口仍可自行设置。 */
const STANDARD_THINK_LEVELS = ["low", "medium", "high", "xhigh", "max"]

/** 当前模型在 OpenCode 配置里的推理强度信息（供思考按钮与选择器共用）。 */
function thinkInfo(viewer) {
  const model = viewer.sessionSettings?.model ?? state.model
  const match = state.models.find((item) => item.providerID === model?.providerID && item.modelID === model?.modelID)
  return { match, variants: match?.variants ?? [], defaultEffort: match?.defaultEffort ?? "" }
}

function renderThinkButton(viewer, match) {
  const button = viewer.querySelector(".context-think-button")
  if (!button) return
  const variants = match?.variants ?? []
  const levels = variants.length ? variants : STANDARD_THINK_LEVELS
  const defaultEffort = match?.defaultEffort ?? ""
  const current = viewer.sessionSettings?.variant ?? ""
  // 生效强度：节点显式设置优先，否则用 OpenCode 配置的默认值；不再显示「默认」字样。
  const effective = current || defaultEffort
  button.textContent = effective ? `思考 · ${effective}` : "思考"
  button.disabled = Boolean(viewer.settingsPending)
  button.title = `思考强度（推理 effort）：可选 ${levels.join(" / ")}；当前 ${effective || "未设置（OpenCode 未配置默认）"}`
}

/** 某模型可选的推理强度档位：模型声明的变体，否则标准档位。 */
function thinkLevelsOf(variants) {
  return variants.length ? variants : STANDARD_THINK_LEVELS
}

/** 列出可选档位（只列具体强度，不再单列「默认」项）；生效档位标记为 active。 */
function thinkOptions(viewer) {
  const { variants, defaultEffort } = thinkInfo(viewer)
  const current = viewer.sessionSettings?.variant ?? ""
  const effective = current || defaultEffort
  const levels = thinkLevelsOf(variants).slice()
  if (effective && !levels.includes(effective)) levels.unshift(effective)
  return levels.map((name) => ({
    value: name,
    label: `思考强度 · ${name}`,
    description: name === defaultEffort ? "OpenCode 默认" : variants.length ? `variant = ${name}` : `推理 effort = ${name}`,
    active: name === effective,
  }))
}

function renderThinkPicker(viewer) {
  const popover = viewer.querySelector(".context-think-popover")
  if (!popover) return
  const disabled = viewer.settingsPending ? "disabled" : ""
  popover.querySelector(".context-think-results").innerHTML = thinkOptions(viewer).map((option) => `
    <button type="button" data-think="${escapeHtml(option.value)}" ${disabled} class="${option.active ? "active" : ""}">
      ${escapeHtml(option.label)}<small>${escapeHtml(option.description)}</small>
    </button>`).join("")
}

function openThinkPicker(viewer) {
  hideCommandMenu(viewer)
  hideTuiPicker(viewer)
  viewer.querySelector(".context-model-popover").hidden = true
  const popover = viewer.querySelector(".context-think-popover")
  renderThinkPicker(viewer)
  popover.hidden = false
  viewer.querySelector(".context-think-button").setAttribute("aria-expanded", "true")
}

function closeThinkPicker(viewer, { focus = false } = {}) {
  const popover = viewer.querySelector(".context-think-popover")
  if (!popover || popover.hidden) return
  popover.hidden = true
  viewer.querySelector(".context-think-button").setAttribute("aria-expanded", "false")
  if (focus) viewer.querySelector(".context-prompt").focus()
}

/** 当前上下文用量：取最近一条带 token 统计的助手消息，估算下一轮提示大小。 */
function contextUsageOf(messages) {
  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.tokens)
  if (!last) return 0
  const t = last.tokens
  return (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0)
}

function formatTokens(value) {
  const n = Math.max(0, Math.round(value))
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
}

function renderContextUsage(viewer) {
  const button = viewer.querySelector(".context-usage")
  if (!button) return
  const used = viewer.contextUsage ?? 0
  const limit = Math.max(1, state.contextLimit || 300000)
  const ratio = clamp(used / limit, 0, 1)
  button.querySelector(".context-usage-label").textContent = formatTokens(used)
  const fill = button.querySelector(".context-usage-fill")
  fill.style.width = (ratio * 100).toFixed(1) + "%"
  fill.style.background = `hsl(${Math.round(140 - 140 * ratio)}, 72%, 45%)`
  button.title = `上下文 ${used.toLocaleString()} / ${limit.toLocaleString()} tokens（${Math.round(ratio * 100)}%）· 点击压缩（/compact）`
  button.disabled = Boolean(viewer.compacting) || used === 0
  // 达到上限且开启自动压缩时，自动执行 /compact（不弹确认）。
  if (state.autoCompact && used >= limit && !viewer.compacting && !viewer.autoCompacting && !viewer.pendingCompact &&
      !sendingNodes.has(viewer.dataset.nodeId) && !nodeIsActive(state.nodesById.get(viewer.dataset.nodeId) ?? {})) {
    viewer.autoCompacting = true
    const status = viewer.querySelector(".context-send-status")
    if (status) status.textContent = "上下文已达上限，自动压缩中…"
    void compactContext(viewer, { force: true }).finally(() => { viewer.autoCompacting = false })
  }
}

// 标题大纲：抽取正文标题层级；可点击查看，也可按住中键 / Ctrl+滚轮快速选择跳转。
function collectContextHeadings(viewer) {
  const body = viewer.querySelector(".context-viewer-body")
  if (!body) return []
  const nodes = [...body.querySelectorAll("[data-mid] .msg-text :is(h1, h2, h3, h4), .section-title.context-group")]
  const items = []
  for (const el of nodes) {
    const tag = el.tagName?.toLowerCase() ?? ""
    const level = /^h[1-4]$/.test(tag) ? Number(tag[1]) : 1
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90)
    if (text) items.push({ el, level, text })
  }
  return items
}

function updateContextOutlineSelection(viewer) {
  const panel = viewer.querySelector(".context-outline")
  if (!panel || !viewer.outline) return
  panel.querySelectorAll(".context-outline-item").forEach((el, index) => {
    el.classList.toggle("active", index === viewer.outline.index)
  })
  panel.querySelector(".context-outline-item.active")?.scrollIntoView({ block: "nearest" })
}

function closeContextOutline(viewer, jump, index) {
  const panel = viewer.querySelector(".context-outline")
  const data = viewer.outline
  if (panel) { panel.hidden = true; panel.replaceChildren() }
  viewer.outline = null
  viewer.querySelector(".context-viewer-outline")?.setAttribute("aria-pressed", "false")
  if (jump && data) {
    const target = index != null ? data.items[index] : data.items[data.index]
    target?.el?.scrollIntoView({ block: "start", behavior: "smooth" })
  }
}

function positionContextOutline(viewer, x, y) {
  const panel = viewer.querySelector(".context-outline")
  if (!panel) return
  if (x == null || y == null) {
    panel.style.left = ""
    panel.style.top = ""
    panel.style.right = ""
    return
  }
  const rect = viewer.getBoundingClientRect()
  const width = panel.offsetWidth || 300
  const height = panel.offsetHeight || 220
  panel.style.left = Math.round(clamp(x - rect.left, 6, Math.max(6, rect.width - width - 6))) + "px"
  panel.style.top = Math.round(clamp(y - rect.top, 6, Math.max(6, rect.height - height - 6))) + "px"
  panel.style.right = "auto"
}

function openContextOutline(viewer, { hold = false, x = null, y = null } = {}) {
  const items = collectContextHeadings(viewer)
  if (!items.length) return false
  const previous = viewer.outline?.index ?? 0
  viewer.outline = { items, index: Math.min(previous, items.length - 1), hold }
  const panel = viewer.querySelector(".context-outline")
  panel.innerHTML = `<div class="context-outline-head">${hold ? "滚轮选择 · 松开跳转 · Esc 取消" : "点击标题跳转 · Esc 或点击外部关闭"}</div>` +
    items.map((item, index) => `<button type="button" class="context-outline-item lv${item.level}" data-outline-index="${index}">${escapeHtml(item.text)}</button>`).join("")
  panel.hidden = false
  panel.querySelectorAll(".context-outline-item").forEach((el) => {
    el.onclick = () => closeContextOutline(viewer, true, Number(el.dataset.outlineIndex))
  })
  viewer.querySelector(".context-viewer-outline")?.setAttribute("aria-pressed", "true")
  positionContextOutline(viewer, x, y)
  updateContextOutlineSelection(viewer)
  return true
}

function toggleContextOutline(viewer) {
  if (viewer.outline) { closeContextOutline(viewer, false); return }
  openContextOutline(viewer, { hold: false })
}

function beginContextOutlineHold(viewer, { x = null, y = null, releaseOnPointerUp = true } = {}) {
  if (viewer.outline?.hold) return
  if (viewer.outline) closeContextOutline(viewer, false)
  if (!openContextOutline(viewer, { hold: true, x, y })) return
  const onWheel = (event) => {
    event.preventDefault()
    if (!viewer.outline) return
    const len = viewer.outline.items.length
    viewer.outline.index = (viewer.outline.index + (event.deltaY > 0 ? 1 : -1) + len) % len
    updateContextOutlineSelection(viewer)
  }
  const onMove = (event) => {
    const item = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".context-outline-item")
    if (item && viewer.outline) {
      viewer.outline.index = Number(item.dataset.outlineIndex)
      updateContextOutlineSelection(viewer)
    }
  }
  const finish = (jump) => {
    window.removeEventListener("wheel", onWheel, true)
    window.removeEventListener("pointermove", onMove)
    window.removeEventListener("pointerup", onUp)
    window.removeEventListener("pointercancel", onCancel)
    window.removeEventListener("keydown", onKey, true)
    window.removeEventListener("keyup", onKeyUp, true)
    closeContextOutline(viewer, jump)
  }
  const onUp = () => { if (releaseOnPointerUp) finish(true) }
  const onCancel = () => { if (releaseOnPointerUp) finish(false) }
  const onKey = (event) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    finish(false)
  }
  const onKeyUp = (event) => {
    if (event.key !== "Control" && event.key !== "Meta") return
    event.preventDefault()
    finish(true)
  }
  window.addEventListener("wheel", onWheel, { passive: false, capture: true })
  window.addEventListener("pointermove", onMove)
  window.addEventListener("pointerup", onUp)
  window.addEventListener("pointercancel", onCancel)
  window.addEventListener("keydown", onKey, true)
  window.addEventListener("keyup", onKeyUp, true)
}

const COMPRESS_NO_CONFIRM_KEY = "nodex.compressNoConfirm"
async function compactContext(viewer, { force = false } = {}) {
  const nodeId = viewer.dataset.nodeId
  // 运行中点击压缩：不立即执行，改为「下一条消息发送前先压缩」。
  if (!force && (sendingNodes.has(nodeId) || nodeIsActive(state.nodesById.get(nodeId) ?? {}))) {
    viewer.pendingCompact = true
    const status = viewer.querySelector(".context-send-status")
    if (status) status.textContent = "已安排：下一条消息发送前先压缩上下文"
    return
  }
  if (viewer.compacting || (!viewer.contextUsage && !force)) return
  if (!force && localStorage.getItem(COMPRESS_NO_CONFIRM_KEY) !== "1") {
    const { ok, remember } = await confirmAction({
      title: "压缩会话上下文？",
      text: "将对当前会话调用 OpenCode 原生压缩（/compact）生成摘要，较早的消息可能被合并。",
      action: "压缩",
      remember: "下次不再提醒",
      rememberDefault: true,
    })
    if (!ok) return
    if (remember) localStorage.setItem(COMPRESS_NO_CONFIRM_KEY, "1")
  }
  const status = viewer.querySelector(".context-send-status")
  viewer.compacting = true
  renderContextUsage(viewer)
  status.textContent = "压缩中…"
  status.classList.add("running")
  try {
    await api(`/nodes/${nodeId}/compact`, { method: "POST", body: "{}", timeout: 900000 })
    await reloadContextViewer(nodeId)
    await refresh()
    status.textContent = "压缩请求已提交"
  } catch (error) {
    status.textContent = `压缩失败: ${error.message}`
  } finally {
    viewer.compacting = false
    status.classList.remove("running")
    renderContextUsage(viewer)
  }
}

function renderModelResults(viewer) {
  const search = viewer.querySelector(".context-model-search").value.trim().toLowerCase()
  const active = viewer.sessionSettings?.model
  const models = state.models.filter((item) => `${item.providerName ?? item.providerID} ${item.name ?? item.modelID} ${item.providerID}/${item.modelID}`.toLowerCase().includes(search))
  const disabled = viewer.settingsPending ? "disabled" : ""
  viewer.querySelector(".context-model-results").innerHTML = (!search ? `<button type="button" data-model="" ${disabled} class="${viewer.sessionSettings?.model ? "" : "active"}">使用全局默认模型</button>` : "") + (models.map((item) => `
    <button type="button" data-model="${escapeHtml(item.providerID + "/" + item.modelID)}" ${disabled} class="${active?.providerID === item.providerID && active?.modelID === item.modelID ? "active" : ""}">
      ${escapeHtml(item.name ?? item.modelID)}<small>${escapeHtml(item.providerID + "/" + item.modelID)}</small>
    </button>`).join("") || '<div class="muted">没有匹配的模型</div>')
}

function openModelPicker(viewer, query = "") {
  hideCommandMenu(viewer)
  hideTuiPicker(viewer)
  closeThinkPicker(viewer)
  const popup = viewer.querySelector(".context-model-popover")
  popup.hidden = false
  popup.style.maxHeight = Math.max(80, Math.min(360, window.innerHeight * .55, viewer.querySelector(".context-compose").getBoundingClientRect().top - viewer.getBoundingClientRect().top - 12)) + "px"
  const search = viewer.querySelector(".context-model-search")
  search.value = query
  renderModelResults(viewer)
  search.focus()
}

function closeModelPicker(viewer) {
  viewer.querySelector(".context-model-popover").hidden = true
  viewer.querySelector(".context-prompt").focus()
}

function hideCommandMenu(viewer) {
  viewer.querySelector(".context-command-popover").hidden = true
  viewer.querySelector(".context-prompt").setAttribute("aria-expanded", "false")
}

function hideTuiPicker(viewer) {
  viewer.querySelector(".context-tui-popover").hidden = true
  viewer.tuiPicker = null
}

function renderTuiPicker(viewer) {
  const picker = viewer.tuiPicker
  if (!picker) return
  const query = viewer.querySelector(".context-tui-search").value.toLowerCase()
  let options = []
  if (picker.kind === "agents") {
    options = state.agents.map((agent) => ({ value: agent.name, label: agent.name, description: "主 agent" }))
  } else if (picker.kind === "sessions") {
    options = (picker.messages ?? []).map((session) => ({ value: session.id, label: session.title || session.id, description: session.id }))
  } else if (picker.kind === "skills") {
    options = state.commands.filter((item) => item.source === "skill")
      .map((item) => ({ value: item.name, label: `/${item.name}`, description: item.description ?? "" }))
  } else if (picker.kind === "fork") {
    options = [{ value: "", label: "完整会话", description: "从当前会话创建分支" },
      ...(picker.messages ?? []).filter((message) => message.role === "user")
        .map((message) => ({ value: message.id, label: message.text.slice(0, 80) || message.id, description: "从此消息分支" }))]
  }
  picker.options = options.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(query))
  picker.index = Math.min(picker.index ?? 0, Math.max(0, picker.options.length - 1))
  viewer.querySelector(".context-tui-results").innerHTML = picker.options.map((item, index) => `<button type="button" data-tui-index="${index}" class="${index === picker.index ? "active" : ""}">${escapeHtml(item.label)}<small>${escapeHtml(item.description)}</small></button>`).join("") || '<div class="muted">没有匹配项</div>'
}

function openTuiPicker(viewer, kind, messages = [], query = "") {
  hideCommandMenu(viewer)
  viewer.querySelector(".context-model-popover").hidden = true
  viewer.tuiPicker = { kind, messages, options: [], index: 0 }
  const popup = viewer.querySelector(".context-tui-popover")
  popup.hidden = false
  popup.style.maxHeight = Math.max(80, Math.min(360, window.innerHeight * .55, viewer.querySelector(".context-compose").getBoundingClientRect().top - viewer.getBoundingClientRect().top - 12)) + "px"
  const search = viewer.querySelector(".context-tui-search")
  search.value = query
  search.placeholder = { agents: "搜索 agent", sessions: "搜索会话", skills: "搜索技能", fork: "选择分支起点" }[kind]
  renderTuiPicker(viewer)
  search.focus()
}

async function selectTuiPicker(viewer, index) {
  const picker = viewer.tuiPicker
  const option = picker?.options[index]
  if (!option) return
  hideTuiPicker(viewer)
  const nodeId = viewer.dataset.nodeId
  if (picker.kind === "agents") {
    if (viewer.settingsPending) await viewer.settingsPending
    await setContextSetting(viewer, { agent: option.value })
  } else if (picker.kind === "sessions") {
    let node = state.graph.nodes.find((item) => item.opencodeSessionId === option.value)
    if (!node) {
      node = await api(`/sessions/${encodeURIComponent(option.value)}/attach`, {
        method: "POST", body: JSON.stringify({ workspaceId: state.activeWs }),
      })
      await refresh()
    }
    await openContextViewer(node.id)
  } else if (picker.kind === "skills") {
    setContextPrompt(viewer, `/${option.value} `)
  } else if (picker.kind === "fork") {
    const created = await api(`/nodes/${nodeId}/fork`, {
      method: "POST", body: JSON.stringify(option.value ? { messageId: option.value } : {}),
    })
    await refresh()
    await openContextViewer(created.id)
  }
}

function thinkingVisible(viewer) {
  return viewer.viewOptions.outputOnly ? false : Boolean(viewer.viewOptions.showThinking)
}

function inputVisible(viewer) {
  if (viewer.exportMode) return true
  return viewer.viewOptions.outputOnly ? false : Boolean(viewer.viewOptions.showInput)
}

/** 把会话文件的相对路径构造成目录树；仅用于展示分组。 */
function buildContextFilesTree(files) {
  const root = { name: "", dirs: new Map(), files: [] }
  for (const file of files) {
    const rel = String(file.rel ?? file.name ?? "")
    const parts = rel.split("/").filter(Boolean)
    if (!parts.length) continue
    let node = root
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i]
      let child = node.dirs.get(seg)
      if (!child) { child = { name: seg, dirs: new Map(), files: [] }; node.dirs.set(seg, child) }
      node = child
    }
    node.files.push({ file, name: parts[parts.length - 1] })
  }
  return root
}

function countContextTreeFiles(node) {
  let total = node.files.length
  for (const dir of node.dirs.values()) total += countContextTreeFiles(dir)
  return total
}

/**
 * 懒加载式渲染：只输出当前展开层级；目录内文件数 > 2 才显示为目录，否则把文件直接铺到上一层。
 * 子层级要等点击目录展开才生成 DOM，避免长会话一下子渲染大量行。
 */
function contextFileRowsHtml(node, viewer, groupKey, level = 0) {
  const rows = []
  const walk = (current, path, depth) => {
    for (const entry of current.files) {
      const file = entry.file
      rows.push(`<div class="file-row ${file.exists ? "" : "missing"}" data-path="${escapeHtml(file.path)}" title="${escapeHtml(file.path)}" style="padding-left:${8 + depth * 14}px"><span class="file-kind">${escapeHtml(file.kind)}</span><span class="file-name">${escapeHtml(entry.name)}</span><span class="file-size">${file.exists ? formatSize(file.size) : "不存在"}</span></div>`)
    }
    for (const dir of current.dirs.values()) {
      const dirPath = path ? `${path}/${dir.name}` : dir.name
      const total = countContextTreeFiles(dir)
      if (total > 2) {
        const open = viewer.filesExpanded.has(`${groupKey}:${dirPath}`)
        rows.push(`<div class="file-dir" data-dir="${escapeHtml(dirPath)}" data-group="${escapeHtml(groupKey)}" style="padding-left:${8 + depth * 14}px" title="${escapeHtml(dirPath)}"><span class="file-caret">${open ? "▾" : "▸"}</span><span class="file-kind">dir</span><span class="file-name">${escapeHtml(dir.name)}</span><span class="file-size">${total} 项</span></div>`)
        if (open) walk(dir, dirPath, depth + 1)
      } else {
        walk(dir, dirPath, depth)
      }
    }
  }
  walk(node, "", level)
  return rows.join("")
}

function renderContextFiles(viewer, payload, error) {
  const body = viewer.querySelector(".context-files-body")
  const rootEl = viewer.querySelector(".context-files-root")
  if (!body) return
  if (error || !payload) {
    rootEl.textContent = ""
    viewer.filesData = null
    body.innerHTML = `<div class="msg error">${escapeHtml(error ?? "加载失败")}</div>`
    return
  }
  viewer.filesData = payload
  if (!viewer.filesExpanded) viewer.filesExpanded = new Set()
  if (!viewer.filesGroups) viewer.filesGroups = { output: true, input: false, unknown: false }
  paintContextFiles(viewer)
}

/** 按当前展开状态重绘文件树：默认展开输出文件、折叠输入文件。 */
function paintContextFiles(viewer) {
  const body = viewer.querySelector(".context-files-body")
  const rootEl = viewer.querySelector(".context-files-root")
  const payload = viewer.filesData
  if (!body || !payload) return
  rootEl.textContent = payload.root ?? ""
  const files = payload.files ?? []
  const groups = [
    { key: "output", label: "输出文件" },
    { key: "input", label: "输入文件" },
    { key: "unknown", label: "其它文件" },
  ]
  const html = groups.map((group) => {
    const list = files.filter((file) => (file.direction ?? "unknown") === group.key)
    if (!list.length) return ""
    const open = viewer.filesGroups[group.key] !== false
    const rows = open ? contextFileRowsHtml(buildContextFilesTree(list), viewer, group.key) : ""
    return `<div class="context-files-group"><div class="context-files-group-title" data-files-group="${group.key}"><span class="file-caret">${open ? "▾" : "▸"}</span>${group.label} · ${list.length}</div>${rows}</div>`
  }).join("")
  body.innerHTML = html || `<div class="muted">暂无文件</div>`
  body.querySelectorAll(".file-row").forEach((el) => { el.onclick = () => openFileViewer(el.dataset.path, viewer.dataset.nodeId) })
  body.querySelectorAll(".file-dir").forEach((el) => {
    el.onclick = () => {
      const key = `${el.dataset.group}:${el.dataset.dir}`
      if (viewer.filesExpanded.has(key)) viewer.filesExpanded.delete(key)
      else viewer.filesExpanded.add(key)
      paintContextFiles(viewer)
    }
  })
  body.querySelectorAll(".context-files-group-title").forEach((el) => {
    el.onclick = () => {
      const key = el.dataset.filesGroup
      viewer.filesGroups[key] = !(viewer.filesGroups[key] !== false)
      paintContextFiles(viewer)
    }
  })
}

function renderViewOptions(viewer) {
  const popover = viewer.querySelector(".context-view-popover")
  if (!popover) return
  const o = viewer.viewOptions
  popover.querySelectorAll("input[data-view]").forEach((input) => {
    input.checked = Boolean(o[input.dataset.view])
    const forced = o.outputOnly && input.dataset.view !== "outputOnly"
    input.disabled = forced
    input.closest("label").classList.toggle("disabled", forced)
  })
}

function applyViewOptions(viewer) {
  const body = viewer.querySelector(".context-viewer-body")
  const button = viewer.querySelector(".context-viewer-view")
  if (button) {
    button.setAttribute("aria-pressed", String(viewer.viewOptions.outputOnly))
    button.title = viewer.viewOptions.outputOnly
      ? "只显示输出正文（点击调整显示选项）"
      : "显示选项：思考过程 / 输入"
  }
  renderViewOptions(viewer)
  if (!body) return
  const showInput = inputVisible(viewer)
  const showThinking = thinkingVisible(viewer)
  const expand = !viewer.viewOptions.outputOnly && viewer.viewOptions.expandThinking
  body.querySelectorAll(".context-message").forEach((message) => {
    const isUser = message.classList.contains("user")
    if (isUser) { message.hidden = !showInput; return }
    const thinking = message.querySelector(".thinking")
    if (thinking) {
      thinking.hidden = !showThinking
      if (showThinking) thinking.open = expand
    }
    const hasText = (message.querySelector(".msg-text")?.textContent || "").trim().length > 0
    const running = message.classList.contains("is-running")
    message.hidden = !showThinking && !hasText && !running
  })
}

async function runTuiCommand(viewer, command, query = "") {
  if (viewer.settingsPending) await viewer.settingsPending
  const nodeId = viewer.dataset.nodeId
  const status = viewer.querySelector(".context-send-status")
  if (command.action === "models") { openModelPicker(viewer, query); return }
  if (command.action === "sessions") {
    const data = await api("/sessions")
    openTuiPicker(viewer, "sessions", data.sessions ?? [], query)
    return
  }
  if (command.action === "agents" || command.action === "skills") {
    openTuiPicker(viewer, command.action, [], query)
    return
  }
  if (command.action === "thinking") {
    const o = viewer.viewOptions
    if (o.outputOnly || !o.showThinking) {
      o.outputOnly = false; o.showThinking = true; o.expandThinking = false
    } else if (!o.expandThinking) {
      o.expandThinking = true
    } else {
      o.showThinking = false; o.expandThinking = false
    }
    state.viewOptions = { ...o }
    saveViewOptions()
    applyViewOptions(viewer)
    return
  }
  if (command.action === "fork") {
    const detail = await api(`/nodes/${nodeId}`)
    openTuiPicker(viewer, "fork", detail.messages ?? [])
    return
  }
  if (command.action === "new") {
    const created = await api("/nodes", {
      method: "POST", body: JSON.stringify({ title: "新会话", workspaceId: state.activeWs, model: viewer.sessionSettings?.model ?? state.model }),
    })
    let settingError = null
    if (viewer.sessionSettings?.agent) {
      try {
        await api(`/nodes/${created.id}/session-settings`, {
          method: "PUT", body: JSON.stringify({ agent: viewer.sessionSettings.agent }),
        })
      } catch (error) { settingError = error }
    }
    await refresh()
    await openContextViewer(created.id)
    if (settingError) throw new Error(`新会话已创建，但模式保存失败: ${settingError.message}`)
    return
  }
  if (command.action === "compact") {
    await compactContext(viewer, { force: true })
    return
  }
  if (command.action === "undo") {
    await undoLastStep(viewer)
    return
  }
  if (command.action === "new-compose") {
    const linked = state.graph.links.some((link) => link.from === nodeId || link.to === nodeId)
    if (linked) {
      status.textContent = "该节点已有连接；/new_compose 仅用于没有连接的节点（可先删除连线）"
      return
    }
    if (state.collaborations.some((item) => item.slots.some((slot) => slot.nodeId === nodeId))) {
      status.textContent = "该节点已属于某个协作；如需调整请用「协作模板」面板"
      return
    }
    openNewComposeDialog(nodeId)
    return
  }
}

/** 撤销上一步：确认后调用 OpenCode 原生 revert，回退到最后一条用户消息之前。 */
const UNDO_SKIP_KEY = "nodex.undoSkipConfirm"
function undoConfirmSkipped() {
  try { return localStorage.getItem(UNDO_SKIP_KEY) === "1" } catch { return false }
}
function setUndoConfirmSkipped(value) {
  try { value ? localStorage.setItem(UNDO_SKIP_KEY, "1") : localStorage.removeItem(UNDO_SKIP_KEY) } catch { /* ignore */ }
}
async function undoLastStep(viewer) {
  const nodeId = viewer.dataset.nodeId
  const status = viewer.querySelector(".context-send-status")
  if (viewerIsRunning(viewer)) { status.textContent = "会话仍在运行，请先停止再撤销"; return }
  if (!undoConfirmSkipped()) {
    const { ok, remember } = await confirmAction({
      title: "撤销上一步？",
      text: "将回退到最后一条用户消息之前（OpenCode 原生 revert）：界面会移除这一步的用户消息与 AI 回复，后续对话也不再带上这部分上下文。被撤销的消息仍保留在会话里，可继续撤销更早的步骤。",
      action: "撤销",
      remember: "下次不再提醒（此后 Ctrl+Z / /undo 直接撤销）",
      rememberDefault: true,
    })
    if (!ok) return
    if (remember) setUndoConfirmSkipped(true)
  }
  try {
    const result = await api(`/nodes/${nodeId}/undo`, { method: "POST", body: "{}", timeout: 60000 })
    const undoneText = typeof result?.text === "string" ? result.text.trim() : ""
    if (undoneText) viewer.undonePrompts = [undoneText, ...(viewer.undonePrompts ?? [])].slice(0, 3)
    status.textContent = "已撤销上一步；按 ↑ 可找回被撤销的内容"
    await reloadContextViewer(nodeId)
  } catch (error) {
    status.textContent = `撤销失败: ${error.message}`
  }
}

function updateCommandMenu(viewer) {
  const input = viewer.querySelector(".context-prompt")
  const match = /^\/([^\s]*)$/.exec(input.value)
  if (!match || input.selectionStart !== input.value.length || sendingNodes.has(viewer.dataset.nodeId)) {
    hideCommandMenu(viewer)
    return
  }
  viewer.querySelector(".context-model-popover").hidden = true
  if (Date.now() - state.commandFetchAt > 60000) void loadCommands()
  const query = match[1].toLowerCase()
  const choices = slashChoices(state.commands, query)
  viewer.commandChoices = choices
  viewer.commandIndex = Math.min(viewer.commandIndex ?? 0, Math.max(0, choices.length - 1))
  const popover = viewer.querySelector(".context-command-popover")
  popover.hidden = false
  popover.style.maxHeight = Math.max(80, Math.min(360, window.innerHeight * .55, viewer.querySelector(".context-compose").getBoundingClientRect().top - viewer.getBoundingClientRect().top - 12)) + "px"
  popover.querySelector(".context-command-results").innerHTML = choices.map((item, index) => `<button type="button" role="option" aria-selected="${index === viewer.commandIndex}" data-command-index="${index}" class="${index === viewer.commandIndex ? "active" : ""}"><strong>/${escapeHtml(item.name)}</strong><small>${escapeHtml(item.description || "")}</small></button>`).join("") || '<div class="muted">没有匹配的命令</div>'
  input.setAttribute("aria-expanded", "true")
}

function hidePromptHistory(viewer) {
  viewer.historyIndex = -1
  viewer.historyDraft = ""
}

function setPromptHistoryValue(viewer, index) {
  const text = viewer.promptHistory?.[index]
  if (text === undefined) return
  const input = viewer.querySelector(".context-prompt")
  input.value = text
  autoGrowPrompt(input)
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  viewer.historyIndex = index
  updateCommandMenu(viewer)
}

function selectCommand(viewer, index) {
  const chosen = viewer.commandChoices?.[index]
  if (!chosen) return
  hideCommandMenu(viewer)
  const input = viewer.querySelector(".context-prompt")
  if (chosen.action !== "server") {
    input.value = ""
    void runTuiCommand(viewer, chosen).catch((error) => {
      viewer.querySelector(".context-send-status").textContent = `命令失败: ${error.message}`
    })
  } else {
    setContextPrompt(viewer, `/${chosen.name} `)
  }
}

async function setContextSetting(viewer, patch) {
  if (viewer.settingsPending) return
  const status = viewer.querySelector(".context-send-status")
  // 乐观更新本地设置，避免请求往返期间模型 / 模式 / 发送按钮闪动或置灰。
  const prev = viewer.sessionSettings ?? { model: null, agent: null, variant: null }
  viewer.sessionSettings = {
    model: Object.hasOwn(patch, "model") ? patch.model : prev.model,
    agent: Object.hasOwn(patch, "agent") ? patch.agent : prev.agent,
    variant: Object.hasOwn(patch, "variant") ? patch.variant : prev.variant,
  }
  renderContextControls(viewer)
  const pending = api(`/nodes/${viewer.dataset.nodeId}/session-settings`, {
    method: "PUT", body: JSON.stringify(patch),
  }).then((node) => {
    viewer.sessionSettings = { model: node.meta?.model ?? null, agent: node.meta?.agent ?? null, variant: node.meta?.variant ?? null }
    const current = state.nodesById.get(node.id)
    if (current) current.meta = node.meta
    status.textContent = ""
    return node
  }).catch((error) => {
    viewer.sessionSettings = prev
    renderContextControls(viewer)
    status.textContent = `切换失败: ${error.message}`
    throw error
  }).finally(() => {
    viewer.settingsPending = null
    renderContextControls(viewer)
    if (!viewer.querySelector(".context-model-popover").hidden) renderModelResults(viewer)
    if (!viewer.querySelector(".context-think-popover").hidden) renderThinkPicker(viewer)
  })
  viewer.settingsPending = pending
  if (!viewer.querySelector(".context-model-popover").hidden) renderModelResults(viewer)
  if (!viewer.querySelector(".context-think-popover").hidden) renderThinkPicker(viewer)
  return pending
}

async function openContextViewer(nodeId) {
  let viewer = contextWindows.get(nodeId)
  if (viewer) {
    focusContextViewer(viewer)
    showWindow(viewer)
    return viewer
  }
  viewer = contextTemplate.content.firstElementChild.cloneNode(true)
  viewer.dataset.nodeId = nodeId
  viewer.selectedMessageIds = new Set()
  viewer.promptHistory = []
  viewer.staged = []
  viewer.historyIndex = -1
  viewer.historyDraft = ""
  viewer.viewOptions = { ...state.viewOptions }
  viewer.contextUsage = 0
  viewer.composeCollapsed = false
  renderContextViewerHeading(viewer, state.nodesById.get(nodeId) ?? { title: nodeTitle(nodeId) })
  viewer.querySelector(".context-viewer-body").innerHTML = '<div class="muted">加载中…</div>'
  viewer.querySelector(".context-send").disabled = sendingNodes.has(nodeId)
  const node = state.nodesById.get(nodeId)
  viewer.sessionSettings = { model: node?.meta?.model ?? null, agent: node?.meta?.agent ?? null, variant: node?.meta?.variant ?? null }
  viewer.querySelector(".context-viewer-times").textContent = `创建 ${formatTime(node?.createdAt)} · 最近活跃 ${formatTime(node?.lastActiveAt)}`
  const { w, h } = contextWindowSize()
  viewer.style.width = w + "px"
  viewer.style.height = h + "px"
  document.getElementById("app").append(viewer)
  contextWindows.set(nodeId, viewer)
  viewer.openedAt = Date.now()
  viewer.classList.add("open")
  focusContextViewer(viewer)
  positionContextViewer(viewer, nodeId)
  if (tiledWindowPositions) {
    tiledWindowPositions.set(viewer, {
      style: { left: viewer.style.left, top: viewer.style.top, width: viewer.style.width, height: viewer.style.height, zIndex: "" },
      maximized: false,
    })
    retileContextWindows()
  }
  attachContextViewer(viewer)
  applyTitleButtonConfig(viewer)
  updateTilingButtons()
  updatePersistButtons()
  renderContextControls(viewer)
  await reloadContextViewer(nodeId)
  saveWindowSessionSoon()
  scheduleDraw()
  return viewer
}

function updateContextExport(viewer) {
  const count = viewer.selectedMessageIds.size
  viewer.classList.toggle("exporting", Boolean(viewer.exportMode))
  applyViewOptions(viewer)
  const toggle = viewer.querySelector(".context-export-toggle")
  toggle.classList.toggle("active", Boolean(viewer.exportMode))
  toggle.setAttribute("aria-pressed", String(Boolean(viewer.exportMode)))
  toggle.disabled = Boolean(viewer.exportPending)
  viewer.querySelector(".context-export-actions").hidden = !viewer.exportMode
  viewer.querySelector(".context-export-count").textContent = `已选 ${count} 条`
  viewer.querySelector(".context-export-all").disabled = Boolean(viewer.exportPending)
  viewer.querySelector(".context-export-none").disabled = Boolean(viewer.exportPending)
  viewer.querySelectorAll(".context-message-check").forEach((input) => {
    input.disabled = Boolean(viewer.exportPending) || input.dataset.empty === "true"
    input.closest(".context-message").classList.toggle("selected", Boolean(viewer.exportMode && input.checked))
  })
  viewer.querySelectorAll(".context-range-btn").forEach((button) => {
    const active = (button.dataset.range === "start" ? viewer.rangeStart : viewer.rangeEnd) === button.dataset.mid
    button.classList.toggle("active", active)
    button.setAttribute("aria-pressed", String(active))
    button.disabled = Boolean(viewer.exportPending)
  })
  const fork = viewer.querySelector(".context-export-fork")
  fork.disabled = count !== 1 || Boolean(viewer.exportPending)
  if (count !== 1) fork.checked = false
  viewer.querySelector(".context-export-submit").disabled = !count || Boolean(viewer.exportPending)
}

function renderPendingQuestion(viewer, request) {
  const panel = viewer.querySelector(".context-questions")
  viewer.classList.toggle("awaiting-question", Boolean(request))
  if (request) {
    const progress = viewer.querySelector(".context-message.is-running .msg-progress-label")
    if (progress) progress.textContent = "等待回答"
  }
  if (!request) {
    viewer.questionRequest = null
    panel.hidden = true
    panel.replaceChildren()
    return
  }
  if (viewer.questionRequest?.id === request.id) return
  viewer.questionRequest = request
  viewer.questionAnswers = request.questions.map(() => new Set())
  panel.innerHTML = `<div class="section-title">待回答问题</div>${request.questions.map((question, index) => `
    <div class="context-question-item">
      <div class="muted">${escapeHtml(question.header || `问题 ${index + 1}`)} · ${question.multiple ? "多选" : "单选"}</div>
      <strong>${escapeHtml(question.question)}</strong>
      <div class="context-question-options">${(question.options ?? []).map((option, choice) => `<button type="button" data-question-index="${index}" data-question-choice="${choice}" aria-pressed="false">${escapeHtml(option.label)}${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</button>`).join("")}</div>
      ${question.custom === false ? "" : `<textarea data-question-custom="${index}" aria-label="${escapeHtml(question.header || question.question)}的自定义回答" placeholder="自定义回答"></textarea>`}
    </div>`).join("")}
    <div class="row"><span class="context-question-error" role="alert"></span><button type="button" class="context-question-reject">拒绝回答</button><button type="button" class="context-question-submit primary">提交回答</button></div>`
  panel.hidden = false
}

/**
 * 回答问题后若当前窗口没有活跃的 prompt 流（问题靠轮询发现 / 流已断开），
 * 用轮询看护续写的输出：显示「运行中」状态 + 跑马灯，空闲后做一次完整刷新。
 */
function startAnsweredWatch(viewer) {
  const nodeId = viewer.dataset.nodeId
  if (viewer.answerWatch) return
  const status = viewer.querySelector(".context-send-status")
  if (status) { status.textContent = "运行中…"; status.classList.add("running") }
  setViewerAiRunning(viewer, true)
  const tick = async () => {
    if (contextWindows.get(nodeId) !== viewer) { stopAnsweredWatch(viewer); return }
    try {
      const data = await api("/runtime/status", { timeout: 8000 }).catch(() => null)
      const sessionId = state.nodesById.get(nodeId)?.opencodeSessionId
      const busy = Boolean(data && sessionId && data.available && Object.hasOwn(data.sessions ?? {}, sessionId))
      if (!busy) {
        stopAnsweredWatch(viewer)
        await refreshRuntimeStatus()
        if (contextWindows.get(nodeId) === viewer) await reloadContextViewer(nodeId)
        return
      }
      if (status) { status.textContent = "模型运行中…"; status.classList.add("running") }
      setViewerAiRunning(viewer, true)
      if (contextWindows.get(nodeId) === viewer) await reloadContextViewer(nodeId)
    } catch { /* 瞬时报错时继续轮询，等会话空闲再收尾 */ }
  }
  viewer.answerWatch = setInterval(tick, 2500)
  void tick()
}

function stopAnsweredWatch(viewer) {
  if (viewer.answerWatch) { clearInterval(viewer.answerWatch); viewer.answerWatch = null }
  const status = viewer.querySelector(".context-send-status")
  if (status) {
    status.classList.remove("running")
    if (status.textContent === "运行中…" || status.textContent === "模型运行中…") status.textContent = ""
  }
  setViewerAiRunning(viewer, viewerIsRunning(viewer))
}

async function answerContextQuestion(viewer, reject = false) {
  const request = viewer.questionRequest
  if (!request || viewer.questionSubmitting) return
  const panel = viewer.querySelector(".context-questions")
  const errorEl = panel.querySelector(".context-question-error")
  const answers = request.questions.map((question, index) => {
    const selected = [...viewer.questionAnswers[index]]
    const custom = panel.querySelector(`[data-question-custom="${index}"]`)?.value.trim()
    return question.multiple ? [...selected, ...(custom ? [custom] : [])] : custom ? [custom] : selected
  })
  if (!reject && answers.some((items) => !items.length)) {
    errorEl.textContent = "请回答全部问题"
    return
  }
  viewer.questionSubmitting = true
  panel.querySelectorAll("button").forEach((button) => { button.disabled = true })
  errorEl.textContent = ""
  try {
    const action = reject ? "reject" : "reply"
    await api(`/nodes/${viewer.dataset.nodeId}/questions/${encodeURIComponent(request.id)}/${action}`, {
      method: "POST", body: JSON.stringify(reject ? {} : { answers }), timeout: 15000,
    })
    viewer.questionRequest = null
    panel.hidden = true
    viewer.classList.remove("awaiting-question")
    viewer.querySelector(".context-send-status").textContent = reject ? "已拒绝问题" : "回答已提交"
    // 问题可能是靠轮询发现的（窗口后开 / 流已断开），此时没有活跃的 prompt 流来推送
    // 模型续写的输出。答完后启动一个轻量看护：显示运行状态并轮询直到会话空闲。
    if (!reject && !sendingNodes.has(viewer.dataset.nodeId) && !viewer.answerWatch) {
      startAnsweredWatch(viewer)
    } else {
      await refreshRuntimeStatus()
    }
  } catch (error) {
    // 问题已失效（会话中断 / 超时）：清理面板、恢复输入，并刷新上下文。
    if (error.status === 410 || error.data?.gone) {
      viewer.questionRequest = null
      panel.hidden = true
      panel.replaceChildren()
      viewer.classList.remove("awaiting-question")
      viewer.querySelector(".context-send").disabled = Boolean(viewer.settingsPending)
      viewer.querySelector(".context-send-status").textContent = error.message
      await reloadContextViewer(viewer.dataset.nodeId)
    } else {
      errorEl.textContent = error.message
    }
  } finally {
    viewer.questionSubmitting = false
    panel.querySelectorAll("button").forEach((button) => { button.disabled = false })
  }
}

async function reloadContextViewer(nodeId) {
  const viewer = contextWindows.get(nodeId)
  if (!viewer) return
  const body = viewer.querySelector(".context-viewer-body")
  const budget = 32000
  try {
    const [c, detail, collaboration] = await Promise.all([
      api(`/nodes/${nodeId}/context?budget=${budget}`),
      api(`/nodes/${nodeId}`),
      api(`/nodes/${nodeId}/collaboration-results`),
    ])
    if (contextWindows.get(nodeId) !== viewer) return
    viewer.collaborationMainNodeId = collaboration.mainNodeId
    const messages = detail.messages ?? []
    viewer.lastMessages = messages
    viewer.promptHistory = recentPrompts(messages, viewer.undonePrompts ?? [])
    viewer.historyIndex = -1
    viewer.historyDraft = ""
    viewer.lastCompletedReply = messages.at(-1)?.role === "assistant" && messages.at(-1)?.finish === "stop" && Boolean(messages.at(-1)?.completedAt)
    viewer.contextUsage = contextUsageOf(messages)
    viewer.messageIds = new Set(messages.map((message) => message.id))
    viewer.messageOrder = messages.filter((message) => message.text.trim()).map((message) => message.id)
    if (viewer.rangeStart && !viewer.messageOrder.includes(viewer.rangeStart)) viewer.rangeStart = null
    if (viewer.rangeEnd && !viewer.messageOrder.includes(viewer.rangeEnd)) viewer.rangeEnd = null
    viewer.selectedMessageIds = viewer.rangeStart || viewer.rangeEnd
      ? new Set(selectedMessageRange(viewer.messageOrder, viewer.rangeStart, viewer.rangeEnd))
      : new Set([...viewer.selectedMessageIds].filter((id) => viewer.messageOrder.includes(id)))
    renderContextViewerHeading(viewer, detail.node)
    viewer.querySelector(".context-viewer-times").textContent = `创建 ${formatTime(detail.node.createdAt)} · 最近活跃 ${formatTime(detail.node.lastActiveAt)}`
    if (!viewer.settingsPending) {
      viewer.sessionSettings = { model: detail.node.meta?.model ?? null, agent: detail.node.meta?.agent ?? null, variant: detail.node.meta?.variant ?? null }
      renderContextControls(viewer)
    }
    renderContextUsage(viewer)
    const tierLabel = { hard: "激活节点", soft: "同页面检索", portal: "跨页引用" }
    const byTier = new Map()
    for (const ch of c.chunks) byTier.set(ch.tier, (byTier.get(ch.tier) || 0) + ch.tokens)
    const pct = Math.min(100, Math.round((c.usedTokens / budget) * 100))
    const follow = body.scrollHeight - body.scrollTop - body.clientHeight < 96
    const scrollTop = body.scrollTop
    body.innerHTML = `
      <div class="context-summary"><strong>上下文用量</strong><span class="muted">${c.usedTokens.toLocaleString()} / ${budget.toLocaleString()} tokens</span></div>
      <div class="ctx-bar"><span style="width:${pct}%"></span></div>
      <div class="context-head-meta">${[...byTier].map(([tier, tokens]) => `<span class="tier ${tier}">${tierLabel[tier] || escapeHtml(tier)} · ${tokens.toLocaleString()}t</span>`).join("")}</div>
      ${c.systemPrompt ? `<details class="context-chunk"><summary>System Prompt</summary><pre class="detail">${escapeHtml(c.systemPrompt)}</pre></details>` : ""}
      <div class="section-title context-group">路由来源 · ${c.chunks.length} 段（内容预览）</div>
      ${c.chunks.map((ch) => `<details class="context-chunk"><summary><span class="tier ${ch.tier}">${tierLabel[ch.tier] || escapeHtml(ch.tier)}</span><span class="link-title">${escapeHtml(nodeTitle(ch.nodeId))}</span><span class="muted">${ch.tokens}t${ch.trusted ? "" : " · 不可信"}</span></summary><pre class="detail">${escapeHtml(ch.preview)}${ch.preview.length >= 120 ? "…" : ""}</pre></details>`).join("") || '<div class="muted">无额外路由来源</div>'}
      ${c.overlapNodeIds.length ? `<div class="meta">交叠节点：${c.overlapNodeIds.map((id) => escapeHtml(nodeTitle(id))).join("、")}</div>` : ""}
      ${c.dropped.length ? `<div class="context-drop">预算外未注入：${c.dropped.map((d) => `${escapeHtml(nodeTitle(d.nodeId))}（${tierLabel[d.tier] || escapeHtml(d.tier)}）`).join("、")}</div>` : ""}
      ${collaboration.workers.length ? `<section class="context-workers"><div class="section-title">子节点研究 · ${collaboration.workers.filter((worker) => worker.preview).length}/${collaboration.workers.length} 已完成</div>${collaboration.workers.map((worker) => `<div class="context-worker"><div><strong>${escapeHtml(worker.title)}</strong><span class="muted">${escapeHtml(worker.role)}</span></div><p>${escapeHtml(worker.preview || "尚未生成回复")}</p><button type="button" data-open-collab-node="${escapeHtml(worker.nodeId)}" aria-label="打开${escapeHtml(worker.title)}的会话">打开会话</button></div>`).join("")}</section>` : collaboration.mainNodeId && collaboration.mainNodeId !== nodeId ? `<button type="button" class="context-parent" data-open-collab-node="${escapeHtml(collaboration.mainNodeId)}">返回主节点</button>` : ""}
      <div class="section-title context-group">会话历史 · ${messages.length} 条消息</div>
      <div class="context-messages">
       ${messages.map((m) => `<div class="context-message ${m.role === "user" ? "user" : "assistant"}" data-mid="${escapeHtml(m.id)}"><div class="msg-role"><input type="checkbox" class="context-message-check" data-mid="${escapeHtml(m.id)}" data-empty="${!m.text.trim()}" aria-label="选择${m.role === "user" ? "我" : "助手"}的消息" ${viewer.selectedMessageIds.has(m.id) ? "checked" : ""} ${m.text.trim() ? "" : "disabled"} /><span>${m.role === "user" ? "我" : "助手"}</span>${m.text.trim() ? `<button type="button" class="context-range-btn start" data-range="start" data-mid="${escapeHtml(m.id)}" title="从这条到最新；再点终点可限定区间" aria-label="从这条消息开始" aria-pressed="false">[</button><button type="button" class="context-range-btn" data-range="end" data-mid="${escapeHtml(m.id)}" title="从最早到这条；再点起点可限定区间" aria-label="到这条消息结束" aria-pressed="false">]</button>` : ""}</div>${m.reasoning ? `<details class="thinking"><summary>思考过程</summary><pre class="thinking-text">${escapeHtml(m.reasoning)}</pre></details>` : ""}<div class="msg-text">${renderMarkdown(m.text)}</div></div>`).join("") || '<div class="muted">暂无对话消息</div>'}
      </div>
    `
    applyViewOptions(viewer)
    body.querySelectorAll(".msg-text").forEach(linkifyFilePaths)
    updateContextExport(viewer)
    const loadError = detail.messagesError || c.error
    if (loadError) {
      const banner = document.createElement("div")
      banner.className = "msg error context-load-error"
      banner.textContent = `会话读取不完整：${loadError}（可能是运行时中断，稍后会自动重试）`
      body.prepend(banner)
    }
    viewer.contextLoadError = Boolean(loadError)
    body.scrollTop = follow ? body.scrollHeight : scrollTop
  } catch (error) {
    if (contextWindows.get(nodeId) === viewer) {
      viewer.contextLoadError = true
      const hasHistory = body.querySelector(".context-message")
      if (hasHistory) {
        // 已有历史时保留内容，只提示刷新失败，避免整段对话被错误替换。
        let banner = body.querySelector(".context-load-error")
        if (!banner) {
          banner = document.createElement("div")
          banner.className = "msg error context-load-error"
          body.prepend(banner)
        }
        banner.textContent = `刷新会话失败：${error.message}（显示的是上次内容，稍后会自动重试）`
      } else {
        body.innerHTML = `<div class="msg error">${escapeHtml(error.message)}</div>`
      }
      scheduleContextReloadRetry(nodeId)
    }
  }
}

/** 读取失败后有限次自动重试，运行时恢复后即可看到完整上下文。 */
function scheduleContextReloadRetry(nodeId) {
  const viewer = contextWindows.get(nodeId)
  if (!viewer || viewer.contextRetryTimer) return
  viewer.contextRetryTimer = setTimeout(() => {
    viewer.contextRetryTimer = null
    const current = contextWindows.get(nodeId)
    if (current?.contextLoadError) void reloadContextViewer(nodeId)
  }, 5000)
}

const sendingNodes = new Set()

// 节点标题仍是占位值时，用 AI 元数据补一个标题。除了发送成功路径，长工具调用导致
// 流中断 / 恢复（此时不会走到成功分支）也要补触发，否则节点会一直显示「未命名节点」。
const titleRequests = new Set()
const titleAttemptAt = new Map()
function maybeGenerateNodeTitle(nodeId, { force = false } = {}) {
  const viewer = contextWindows.get(nodeId)
  const node = state.nodesById.get(nodeId)
  if (!node || !needsAutoTitle(node)) return
  if (titleRequests.has(nodeId)) return
  if (!force && viewer?.titleGenerated) return
  if (!force && Date.now() - (titleAttemptAt.get(nodeId) ?? 0) < 60000) return
  titleAttemptAt.set(nodeId, Date.now())
  titleRequests.add(nodeId)
  if (viewer) viewer.titleGenerated = true
  void api(`/nodes/${nodeId}/metadata`, {
    method: "POST", body: JSON.stringify({ model: viewer?.sessionSettings?.model ?? currentModel() }),
  }).then(() => refresh()).catch((error) => {
    titleRequests.delete(nodeId)
    if (viewer) viewer.titleGenerated = false
    statusEl.textContent = `自动生成标题失败：${error.message}（可在节点设置里手动生成）`
  })
}

async function sendContextMessage(viewer, { fromQueue = false } = {}) {
  const nodeId = viewer.dataset.nodeId
  const body = viewer.querySelector(".context-viewer-body")
  const contextPrompt = viewer.querySelector(".context-prompt")
  const contextSend = viewer.querySelector(".context-send")
  const contextSendStatus = viewer.querySelector(".context-send-status")
  if (!nodeId) return
  if (viewer.settingsPending) {
    try { await viewer.settingsPending } catch { return }
  }
  const text = contextPrompt.value.trim()
  if (!text) return
  const commandMatch = /^\/([a-z][\w.:-]*)(?:\s+([\s\S]*))?$/i.exec(text)
  const builtIn = commandMatch ? tuiCommand(commandMatch[1]) : null
  if (builtIn && builtIn.action !== "server") {
    contextPrompt.value = ""
    hideCommandMenu(viewer)
    try { await runTuiCommand(viewer, builtIn, commandMatch[2] ?? "") }
    catch (error) { contextSendStatus.textContent = `命令失败: ${error.message}` }
    return
  }
  if (viewer.questionRequest) { contextSendStatus.textContent = "请先回答待处理问题"; return }
  if (commandMatch && commandMatch[1] !== "compose" && !state.commands.some((item) => item.name === commandMatch[1])) {
    contextSendStatus.textContent = "命令不可用，请检查命令列表"
    return
  }
  if (!fromQueue && (sendingNodes.has(nodeId) || nodeIsActive(state.nodesById.get(nodeId) ?? {}))) {
    viewer.messageQueue = viewer.messageQueue || []
    viewer.messageQueue.push({ text })
    contextPrompt.value = ""
    autoGrowPrompt(contextPrompt)
    hidePromptHistory(viewer)
    contextSendStatus.textContent = `已排队 ${viewer.messageQueue.length} 条，将在当前运行结束后自动发送`
    return
  }
  const messages = body.querySelector(".context-messages")
  if (!messages) { contextSendStatus.textContent = "请等待会话加载完成"; return }
  const generateFirstTitle = !commandMatch && !viewer.titleGenerated &&
    needsAutoTitle(state.nodesById.get(nodeId))
  hideCommandMenu(viewer)
  stopAnsweredWatch(viewer)
  viewer.undonePrompts = []
  sendingNodes.add(nodeId)
  viewer.needsReplySync = false
  viewer.stopRequested = false
  viewer.interruptAt = 0
  contextPrompt.value = ""
  autoGrowPrompt(contextPrompt)
  hidePromptHistory(viewer)
  contextPrompt.focus()
  contextSendStatus.textContent = "等待响应…"
  contextSendStatus.classList.add("running")
  setViewerAiRunning(viewer, true)
  messages.querySelector(".muted")?.remove()
  messages.insertAdjacentHTML("beforeend", `<div class="context-message user is-new"><div class="msg-role">我</div><div class="msg-text">${renderMarkdown(text)}</div></div><div class="context-message assistant is-new is-running"><div class="msg-role">助手 <span class="msg-progress"><span class="msg-progress-spinner" aria-hidden="true"></span><span class="msg-progress-label">等待响应</span></span></div><details class="thinking" open hidden><summary>思考过程</summary><pre class="thinking-text"></pre></details><div class="msg-text"></div></div>`)
  body.scrollTop = body.scrollHeight
  const assistant = messages?.lastElementChild
  const reply = assistant?.querySelector(".msg-text")
  const thinking = assistant?.querySelector(".thinking")
  const thinkingText = thinking?.querySelector(".thinking-text")
  const progressLabel = assistant?.querySelector(".msg-progress-label")
  let rawReply = ""
  let renderFrame = 0
  const flushReply = () => {
    renderFrame = 0
    if (!reply?.isConnected || !rawReply) return
    const follow = body.scrollHeight - body.scrollTop - body.clientHeight < 96
    reply.innerHTML = renderMarkdown(rawReply)
    linkifyFilePaths(reply)
    assistant.classList.add("has-text")
    if (follow) body.scrollTop = body.scrollHeight
  }
  try {
    const payload = commandMatch ? { command: commandMatch[1], arguments: commandMatch[2] ?? "" } : { text }
    const result = await streamPrompt(`/nodes/${nodeId}/prompt/stream`, payload, (event) => {
      if (contextWindows.get(nodeId) !== viewer) return
      if (event.type === "context") markContextLinks(nodeId, event.context)
      if (event.type === "collaboration") {
        contextSendStatus.textContent = event.phase === "summary" ? "正在汇总…" : `${event.label} · ${event.phase === "finished" ? event.completed : event.completed + 1}/${event.total}`
        progressLabel.textContent = event.nodeId === nodeId ? "正在汇总" : event.label
      }
      if (event.type === "tool") {
        const name = event.name || "工具"
        if (event.status === "error") {
          // 单次工具失败通常可自愈（限流 / 超时后换源重试），只做轻提示，
          // 详细错误放进悬停提示，避免把临时失败显示成"会话卡住"。
          const detail = String(event.error ?? "").trim()
          contextSendStatus.textContent = `${name} 调用失败，正在继续`
          if (detail) contextSendStatus.title = `${name}: ${detail}`
          else contextSendStatus.removeAttribute("title")
          progressLabel.textContent = "工具失败，继续运行"
        } else {
          contextSendStatus.textContent = `${name} 运行中…`
          contextSendStatus.removeAttribute("title")
          progressLabel.textContent = `${name} 运行中`
        }
      }
      if (event.type === "question") {
        renderPendingQuestion(viewer, event.request)
        contextSendStatus.textContent = "等待回答"
        contextSendStatus.classList.remove("running")
      }
      if (event.type === "thinking") {
        thinking.hidden = !thinkingVisible(viewer)
        thinkingText.textContent += event.text
        contextSendStatus.textContent = "思考中…"
        progressLabel.textContent = "思考中"
      }
      if (event.type === "text" && reply) {
        rawReply += event.text
        contextSendStatus.textContent = "正在输出…"
        progressLabel.textContent = "正在输出"
        if (!renderFrame) renderFrame = requestAnimationFrame(flushReply)
      }
    }, 900000)
    if (renderFrame) cancelAnimationFrame(renderFrame)
    if (result?.reply) rawReply = result.reply
    flushReply()
    if (thinking && !thinkingText?.textContent) thinking.remove()
    else if (thinking) thinking.open = false
    if (contextWindows.has(nodeId)) {
      await reloadContextViewer(nodeId)
    }
    if (viewer.collaborationMainNodeId && viewer.collaborationMainNodeId !== nodeId && contextWindows.has(viewer.collaborationMainNodeId)) {
      await reloadContextViewer(viewer.collaborationMainNodeId)
    }
    await refresh()
    if (generateFirstTitle) maybeGenerateNodeTitle(nodeId, { force: true })
  } catch (error) {
    if (contextWindows.get(nodeId) === viewer) {
      if (renderFrame) cancelAnimationFrame(renderFrame)
      flushReply()
      // 流中断后原问题多半已无法回答：先收起面板恢复输入，随后 refreshRuntimeStatus
      // 会按运行时真实状态重新同步（仍有效的问题会再次出现）。
      if (viewer.questionRequest) {
        viewer.questionRequest = null
        viewer.classList.remove("awaiting-question")
        const questionPanel = viewer.querySelector(".context-questions")
        if (questionPanel) { questionPanel.hidden = true; questionPanel.replaceChildren() }
      }
      let persisted = false
      let recovered = false
      let checked = false
      try {
        const detail = await api(`/nodes/${nodeId}`)
        checked = true
        const classified = classifySendFailure(detail.messages, {
          text, commandMatch, knownMessageIds: viewer.messageIds ?? new Set(),
        })
        persisted = classified.persisted
        recovered = classified.recovered
      } catch { /* Keep the draft if the session cannot be read back. */ }
      // 无论读取是否成功，都尝试用非破坏方式刷新一次历史。
      if (contextWindows.get(nodeId) === viewer) await reloadContextViewer(nodeId)
      // 流中断但回复其实已完成（长工具调用常见）：同样补一次标题，避免一直「未命名节点」。
      if (recovered) maybeGenerateNodeTitle(nodeId)
      if (!persisted) contextPrompt.value = text + (contextPrompt.value ? `\n\n${contextPrompt.value}` : "")
      autoGrowPrompt(contextPrompt)
      viewer.needsReplySync = persisted && !recovered
      const hint = persisted ? "消息已写入会话，请勿直接重发；可切换模型后继续对话"
        : checked ? "消息未写入会话，可检查模型后重试" : "无法确认消息是否写入，请刷新会话后再决定是否重发"
      const partialCollabHint = error.results?.length
        ? `；${error.results.length} 个子角色已完成，结果保留在各自节点会话，请检查后再重试（重试会重新执行）`
        : ""
      contextSendStatus.textContent = recovered ? "回复已完成，已从会话恢复" : viewer.stopRequested
        ? `已停止。${persisted ? "消息已写入会话，可继续提问" : hint}`
        : `发送失败: ${error.message}${partialCollabHint}。${hint}`
    }
  } finally {
    if (renderFrame) cancelAnimationFrame(renderFrame)
    assistant.classList.remove("is-running")
    contextSendStatus.classList.remove("running")
    contextSendStatus.removeAttribute("title")
    await refreshRuntimeStatus()
    sendingNodes.delete(nodeId)
    if (!sendingNodes.size) state.activeLinks.clear()
    setViewerAiRunning(viewer, viewerIsRunning(viewer))
    const current = contextWindows.get(nodeId)
    if (current) current.querySelector(".context-send").disabled = Boolean(current.questionRequest)
    if (current === viewer && !viewer.stopRequested && !contextSendStatus.textContent.startsWith("发送失败") && !contextSendStatus.textContent.startsWith("回复已完成")) contextSendStatus.textContent = ""
    draw()
    void drainMessageQueue(viewer)
  }
}

/** 当前运行结束后自动发送排队的消息；若排了压缩，则先压缩再发送。 */
async function drainMessageQueue(viewer) {
  const nodeId = viewer.dataset.nodeId
  if (!canDrainQueue({
    statusAvailable: state.runtimeStatusAvailable,
    runtimeStatus: state.runtimeStatus,
    sessionId: state.nodesById.get(nodeId)?.opencodeSessionId,
    sending: sendingNodes.has(nodeId),
    queueLength: viewer.messageQueue?.length ?? 0,
  })) return
  const queue = viewer.messageQueue
  if (!queue?.length) return
  const contextPrompt = viewer.querySelector(".context-prompt")
  if (!contextPrompt) return
  const next = queue.shift()
  if (viewer.pendingCompact) {
    viewer.pendingCompact = false
    const status = viewer.querySelector(".context-send-status")
    status.textContent = "先压缩上下文，再发送排队的消息…"
    try { await compactContext(viewer, { force: true }) } catch { /* 压缩失败仍继续发送 */ }
  }
  if (!contextPrompt.isConnected) return
  contextPrompt.value = next.text
  autoGrowPrompt(contextPrompt)
  await sendContextMessage(viewer, { fromQueue: true })
}

function closeContextViewer(viewer) {
  contextWindows.delete(viewer.dataset.nodeId)
  if (viewer.contextRetryTimer) { clearTimeout(viewer.contextRetryTimer); viewer.contextRetryTimer = null }
  if (viewer.answerWatch) { clearInterval(viewer.answerWatch); viewer.answerWatch = null }
  tiledWindowPositions?.delete(viewer)
  tileOrder = tileOrder.filter((item) => item !== viewer)
  viewer.remove()
  if (tiledWindowPositions) retileContextWindows()
  saveWindowSessionSoon()
  scheduleDraw()
}

function viewerIsRunning(viewer) {
  return viewer.aborting || sendingNodes.has(viewer.dataset.nodeId) ||
    nodeIsActive(state.nodesById.get(viewer.dataset.nodeId) ?? {})
}

/** AI 运行边框跑马灯：真实 busy 或正在发送时给窗口加 .ai-running。 */
function setViewerAiRunning(viewer, running) {
  if (viewer) viewer.classList.toggle("ai-running", Boolean(running))
}

async function interruptContextViewer(viewer) {
  if (viewer.aborting) return
  const status = viewer.querySelector(".context-send-status")
  const now = Date.now()
  if (!viewer.interruptAt || now - viewer.interruptAt > 5000) {
    viewer.interruptAt = now
    status.textContent = "再次按 Esc 停止运行"
    setTimeout(() => {
      if (viewer.interruptAt === now && status.textContent === "再次按 Esc 停止运行") status.textContent = ""
    }, 5000)
    return
  }
  viewer.interruptAt = 0
  viewer.aborting = true
  viewer.stopRequested = true
  status.textContent = "正在停止…"
  try {
    const result = await api(`/nodes/${viewer.dataset.nodeId}/abort`, { method: "POST", body: "{}", timeout: 20000 })
    if (contextWindows.get(viewer.dataset.nodeId) === viewer) status.textContent = result.aborted ? "已请求停止" : "会话已空闲"
  } catch (error) {
    viewer.stopRequested = false
    if (contextWindows.get(viewer.dataset.nodeId) === viewer) status.textContent = `停止失败: ${error.message}`
  } finally {
    viewer.aborting = false
  }
}

function attachWindowResize(viewer, options = {}) {
  const minW = options.minWidth ?? 300
  const minH = options.minHeight ?? 240
  viewer.querySelectorAll(".win-resize").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return
      if (tiledWindowPositions || viewer.classList.contains("maximized")) return
      event.preventDefault()
      event.stopPropagation()
      options.onStart?.()
      const edge = handle.dataset.edge
      const rect = viewer.getBoundingClientRect()
      const start = { x: event.clientX, y: event.clientY, w: rect.width, h: rect.height, left: rect.left, top: rect.top }
      viewer.classList.add("resizing")
      handle.setPointerCapture(event.pointerId)
      const move = (e) => {
        const dx = e.clientX - start.x
        const dy = e.clientY - start.y
        let w = start.w, h = start.h
        if (edge.includes("e")) w = start.w + dx
        if (edge.includes("w")) w = start.w - dx
        if (edge.includes("s")) h = start.h + dy
        w = clamp(w, minW, window.innerWidth - 8)
        h = clamp(h, minH, window.innerHeight - 8)
        if (edge.includes("w")) viewer.style.left = Math.max(0, Math.round(start.left + (start.w - w))) + "px"
        viewer.style.width = Math.round(w) + "px"
        viewer.style.height = Math.round(h) + "px"
        scheduleDraw()
      }
      const stop = () => {
        handle.removeEventListener("pointermove", move)
        handle.removeEventListener("pointerup", stop)
        handle.removeEventListener("pointercancel", stop)
        viewer.classList.remove("resizing")
        scheduleDraw()
        if (!viewer.isConnected) return
        const next = viewer.getBoundingClientRect()
        options.save?.(Math.round(next.width), Math.round(next.height))
      }
      handle.addEventListener("pointermove", move)
      handle.addEventListener("pointerup", stop, { once: true })
      handle.addEventListener("pointercancel", stop, { once: true })
    })
  })
}

function attachContextViewer(viewer) {
  const nodeId = viewer.dataset.nodeId
  viewer.addEventListener("pointerdown", (event) => {
    // 标题栏按钮与窗口内交互控件（关闭 / 最大化 / 分屏 / 摘要等）不应触发「切到前台」，
    // 否则台前调度下点关闭会先被换到主区、点击落空导致关不掉。
    if (!shouldSkipWindowFocus(viewer, event.target)) focusContextViewer(viewer)
    if (!event.target.closest(".context-think-button, .context-think-popover")) closeThinkPicker(viewer)
    if (!event.target.closest(".context-viewer-view, .context-view-popover")) {
      viewer.querySelector(".context-view-popover").hidden = true
    }
    if (!event.target.closest(".context-viewer-files, .context-files-popover")) {
      viewer.querySelector(".context-files-popover").hidden = true
    }
    if (!viewer.outline?.hold && !event.target.closest(".context-viewer-outline, .context-outline")) {
      closeContextOutline(viewer, false)
    }
  })
  enablePathDrop(viewer, () => viewer.querySelector(".context-prompt"))
  viewer.querySelector(".context-viewer-close").onclick = () => closeContextViewer(viewer)
  viewer.querySelector(".context-viewer-persist").onclick = () => toggleWindowPersist(viewer)
  viewer.querySelector(".context-viewer-rename").onclick = () => startTitleRename(
    viewer.querySelector(".context-viewer-title"),
    viewer.dataset.nodeId,
    "会话",
    () => renderContextViewerHeading(viewer, viewer.headingNode ?? state.nodesById.get(viewer.dataset.nodeId)),
  )
  viewer.querySelector(".context-questions").addEventListener("click", (event) => {
    const option = event.target.closest("[data-question-choice]")
    if (option && viewer.questionRequest && !viewer.questionSubmitting) {
      const index = Number(option.dataset.questionIndex)
      const choice = viewer.questionRequest.questions[index]?.options[Number(option.dataset.questionChoice)]
      if (!choice) return
      const selected = viewer.questionAnswers[index]
      if (!viewer.questionRequest.questions[index].multiple) {
        selected.clear()
        const custom = viewer.querySelector(`[data-question-custom="${index}"]`)
        if (custom) custom.value = ""
      }
      if (selected.has(choice.label)) selected.delete(choice.label)
      else selected.add(choice.label)
      viewer.querySelectorAll(`[data-question-index="${index}"]`).forEach((button) => {
        const active = selected.has(viewer.questionRequest.questions[index].options[Number(button.dataset.questionChoice)].label)
        button.classList.toggle("active", active)
        button.setAttribute("aria-pressed", String(active))
      })
      return
    }
    if (event.target.closest(".context-question-submit")) void answerContextQuestion(viewer)
    if (event.target.closest(".context-question-reject")) void answerContextQuestion(viewer, true)
  })
  viewer.querySelector(".context-questions").addEventListener("keydown", (event) => {
    // QA 面板：回车确认回答（自定义回答里换行用 Shift+Enter）；方向键在选项按钮间仍可切换。
    if (event.isComposing || event.key !== "Enter" || event.shiftKey) return
    if (event.target.closest("[data-question-choice], .context-question-reject")) return
    event.preventDefault()
    void answerContextQuestion(viewer)
  })
  viewer.querySelector(".context-questions").addEventListener("input", (event) => {
    const input = event.target.closest("[data-question-custom]")
    if (!input || !viewer.questionRequest || viewer.questionRequest.questions[Number(input.dataset.questionCustom)]?.multiple || !input.value.trim()) return
    const index = Number(input.dataset.questionCustom)
    viewer.questionAnswers[index].clear()
    viewer.querySelectorAll(`[data-question-index="${index}"]`).forEach((button) => {
      button.classList.remove("active")
      button.setAttribute("aria-pressed", "false")
    })
  })
  viewer.querySelector(".context-viewer-tile").onclick = tileContextWindows
  viewer.querySelector(".context-viewer-pin").onclick = () => toggleWindowPin(viewer)
  viewer.querySelector(".context-viewer-collapse").onclick = () => {
    const collapsed = !viewer.composeCollapsed
    setComposeCollapsed(viewer, collapsed, { focus: !collapsed })
  }
  viewer.querySelector(".context-compose-collapsed").onclick = () => setComposeCollapsed(viewer, false, { focus: true })
  viewer.querySelector(".context-viewer-view").onclick = () => {
    const popover = viewer.querySelector(".context-view-popover")
    const willOpen = popover.hidden
    viewer.querySelector(".context-files-popover").hidden = true
    popover.hidden = !willOpen
    if (willOpen) renderViewOptions(viewer)
  }
  viewer.querySelector(".context-view-popover").addEventListener("change", (event) => {
    const input = event.target.closest("input[data-view]")
    if (!input) return
    viewer.viewOptions[input.dataset.view] = input.checked
    state.viewOptions = { ...viewer.viewOptions }
    saveViewOptions()
    applyViewOptions(viewer)
  })
  viewer.querySelector(".context-viewer-files").onclick = () => {
    const popover = viewer.querySelector(".context-files-popover")
    const willOpen = popover.hidden
    viewer.querySelector(".context-view-popover").hidden = true
    popover.hidden = !willOpen
    if (!willOpen) return
    viewer.querySelector(".context-files-body").innerHTML = '<div class="muted">加载中…</div>'
    api(`/nodes/${nodeId}/files`)
      .then((payload) => renderContextFiles(viewer, payload))
      .catch((error) => renderContextFiles(viewer, null, error.message))
  }
  viewer.querySelector(".context-usage").onclick = () => compactContext(viewer)
  viewer.querySelector(".context-viewer-outline").onclick = () => toggleContextOutline(viewer)
  const outlineBody = viewer.querySelector(".context-viewer-body")
  outlineBody.addEventListener("pointerdown", (event) => {
    if (event.button !== 1) return
    event.preventDefault()
    beginContextOutlineHold(viewer, { x: event.clientX, y: event.clientY })
  })
  outlineBody.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault()
  })
  outlineBody.addEventListener("mousedown", (event) => {
    if (event.button === 1) event.preventDefault()
  })
  outlineBody.addEventListener("wheel", (event) => {
    if ((!event.ctrlKey && !event.metaKey) || viewer.outline) return
    event.preventDefault()
    beginContextOutlineHold(viewer, { x: event.clientX, y: event.clientY, releaseOnPointerUp: false })
  }, { passive: false })
  viewer.querySelector(".context-viewer-max").onclick = () => toggleWindowMaximize(viewer)
  viewer.querySelector(".context-viewer-settings").onclick = () => {
    state.selection = { type: "node", id: nodeId }
    panel.style.zIndex = String(++windowLayer)
    openNodePanel(nodeId).catch((error) => (statusEl.textContent = error.message))
  }
  viewer.querySelector(".context-send").onclick = () => sendContextMessage(viewer)
  viewer.querySelector(".context-stage-btn").onclick = () => stagePromptText(viewer)
  viewer.querySelector(".context-staged").addEventListener("click", (event) => {
    const chip = event.target.closest(".context-staged-chip")
    if (!chip) return
    if (event.target.closest(".context-staged-close")) removeStaged(viewer, chip.dataset.id)
    else if (event.target.closest(".context-staged-restore")) restoreStaged(viewer, chip.dataset.id)
  })
  viewer.querySelector(".context-export-toggle").onclick = () => {
    viewer.exportMode = !viewer.exportMode
    if (!viewer.exportMode) {
      viewer.rangeStart = null
      viewer.rangeEnd = null
      viewer.selectedMessageIds.clear()
      viewer.querySelectorAll(".context-message-check:checked").forEach((input) => { input.checked = false })
    }
    viewer.querySelector(".context-export-status").textContent = ""
    updateContextExport(viewer)
  }
  viewer.querySelector(".context-viewer-body").addEventListener("change", (event) => {
    if (!event.target.matches(".context-message-check")) return
    viewer.rangeStart = null
    viewer.rangeEnd = null
    if (event.target.checked) viewer.selectedMessageIds.add(event.target.dataset.mid)
    else viewer.selectedMessageIds.delete(event.target.dataset.mid)
    updateContextExport(viewer)
  })
  viewer.querySelector(".context-export-all").onclick = () => {
    viewer.rangeStart = null
    viewer.rangeEnd = null
    viewer.querySelectorAll(".context-message-check:not(:disabled)").forEach((input) => {
      input.checked = true
      viewer.selectedMessageIds.add(input.dataset.mid)
    })
    updateContextExport(viewer)
  }
  viewer.querySelector(".context-export-none").onclick = () => {
    viewer.rangeStart = null
    viewer.rangeEnd = null
    viewer.selectedMessageIds.clear()
    viewer.querySelectorAll(".context-message-check:checked").forEach((input) => { input.checked = false })
    updateContextExport(viewer)
  }
  viewer.querySelector(".context-viewer-body").addEventListener("click", (event) => {
    const child = event.target.closest("[data-open-collab-node]")
    if (child) {
      void openContextViewer(child.dataset.openCollabNode).catch((error) => (statusEl.textContent = error.message))
      return
    }
    const button = event.target.closest(".context-range-btn")
    if (button) {
      if (!viewer.exportMode || viewer.exportPending) return
      const key = button.dataset.range === "start" ? "rangeStart" : "rangeEnd"
      viewer[key] = viewer[key] === button.dataset.mid ? null : button.dataset.mid
      viewer.selectedMessageIds = new Set(selectedMessageRange(viewer.messageOrder, viewer.rangeStart, viewer.rangeEnd))
      viewer.querySelectorAll(".context-message-check").forEach((input) => {
        input.checked = viewer.selectedMessageIds.has(input.dataset.mid)
      })
      updateContextExport(viewer)
      return
    }
    const message = event.target.closest(".context-message")
    if (!message || !viewer.exportMode || viewer.exportPending) return
    if (event.target.closest("a, button, input, select, textarea, details, summary, pre, code, label")) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    const check = message.querySelector(".context-message-check")
    if (!check || check.disabled) return
    check.checked = !check.checked
    viewer.rangeStart = null
    viewer.rangeEnd = null
    if (check.checked) viewer.selectedMessageIds.add(check.dataset.mid)
    else viewer.selectedMessageIds.delete(check.dataset.mid)
    updateContextExport(viewer)
  })
  viewer.querySelector(".context-export-submit").onclick = async () => {
    const messageIds = [...viewer.selectedMessageIds]
    if (!messageIds.length || viewer.exportPending) return
    viewer.exportPending = true
    const status = viewer.querySelector(".context-export-status")
    status.textContent = ""
    updateContextExport(viewer)
    try {
      const mode = viewer.querySelector(".context-export-fork").checked && messageIds.length === 1 ? "fork" : "context"
      const result = await api(`/nodes/${nodeId}/export`, {
        method: "POST", body: JSON.stringify({ messageIds, mode, workspaceId: state.activeWs }),
      })
      await refresh()
      await openContextViewer(result.node.id)
      viewer.selectedMessageIds.clear()
      viewer.rangeStart = null
      viewer.rangeEnd = null
      viewer.querySelectorAll(".context-message-check:checked").forEach((input) => { input.checked = false })
      viewer.exportMode = false
      statusEl.textContent = `已导出「${result.node.title}」（${result.exportedBy === "fork" ? "原生分支" : "上下文种子"}，${result.count} 条）`
    } catch (error) {
      status.textContent = `导出失败: ${error.message}`
    } finally {
      viewer.exportPending = false
      updateContextExport(viewer)
    }
  }
  viewer.querySelector(".context-model-button").onclick = () => {
    hideCommandMenu(viewer)
    if (viewer.querySelector(".context-model-popover").hidden) openModelPicker(viewer)
    else closeModelPicker(viewer)
  }
  viewer.querySelector(".context-command-results").addEventListener("click", (event) => {
    const option = event.target.closest("button[data-command-index]")
    if (option) selectCommand(viewer, Number(option.dataset.commandIndex))
  })
  viewer.querySelector(".context-tui-search").addEventListener("input", () => { if (viewer.tuiPicker) { viewer.tuiPicker.index = 0; renderTuiPicker(viewer) } })
  viewer.querySelector(".context-tui-search").addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return
    const picker = viewer.tuiPicker
    if (!picker) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      if (picker.options.length) picker.index = (picker.index + (event.key === "ArrowDown" ? 1 : -1) + picker.options.length) % picker.options.length
      renderTuiPicker(viewer)
      viewer.querySelector(".context-tui-results button.active")?.scrollIntoView({ block: "nearest" })
    } else if (event.key === "Enter") {
      event.preventDefault()
      void selectTuiPicker(viewer, picker.index).catch((error) => {
        viewer.querySelector(".context-send-status").textContent = `命令失败: ${error.message}`
      })
    }
  })
  viewer.querySelector(".context-tui-results").addEventListener("click", (event) => {
    const option = event.target.closest("button[data-tui-index]")
    if (option) void selectTuiPicker(viewer, Number(option.dataset.tuiIndex)).catch((error) => {
      viewer.querySelector(".context-send-status").textContent = `命令失败: ${error.message}`
    })
  })
  viewer.querySelector(".context-model-search").addEventListener("input", () => renderModelResults(viewer))
  viewer.querySelector(".context-model-search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); viewer.querySelector(".context-model-results button")?.click() }
  })
  viewer.querySelector(".context-model-results").addEventListener("click", async (event) => {
    const selected = event.target.closest("button[data-model]")
    if (!selected) return
    if (selected.dataset.model === "") {
      try { await setContextSetting(viewer, { model: null }); closeModelPicker(viewer) } catch { /* Error is shown next to the session input. */ }
      return
    }
    const model = state.models.find((item) => `${item.providerID}/${item.modelID}` === selected.dataset.model)
    if (!model) return
    try {
      await setContextSetting(viewer, { model: { providerID: model.providerID, modelID: model.modelID } })
      closeModelPicker(viewer)
    } catch { /* Error is shown next to the session input. */ }
  })
  viewer.querySelector(".context-mode").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-agent]")
    if (button && !button.disabled && viewer.sessionSettings?.agent !== button.dataset.agent) {
      void setContextSetting(viewer, { agent: button.dataset.agent }).catch(() => {})
    }
  })
  viewer.querySelector(".context-think-button").onclick = () => {
    if (viewer.querySelector(".context-think-popover").hidden) openThinkPicker(viewer)
    else closeThinkPicker(viewer)
  }
  viewer.querySelector(".context-think-results").addEventListener("click", (event) => {
    const option = event.target.closest("button[data-think]")
    if (!option) return
    const value = option.dataset.think || null
    // 选中 OpenCode 默认档位时清空节点覆盖（继续跟随 OpenCode），否则写入显式强度。
    const { defaultEffort } = thinkInfo(viewer)
    const next = value && value === defaultEffort ? null : value
    closeThinkPicker(viewer)
    if ((viewer.sessionSettings?.variant ?? null) === next) return
    void setContextSetting(viewer, { variant: next }).catch(() => {})
  })
  viewer.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && viewer.tuiPicker) {
      event.preventDefault()
      event.stopPropagation()
      hideTuiPicker(viewer)
      viewer.querySelector(".context-prompt").focus()
    } else if (event.key === "Escape" && !viewer.querySelector(".context-model-popover").hidden) {
      event.preventDefault()
      event.stopPropagation()
      closeModelPicker(viewer)
    } else if (event.key === "Escape" && !viewer.querySelector(".context-think-popover").hidden) {
      event.preventDefault()
      event.stopPropagation()
      closeThinkPicker(viewer, { focus: true })
    } else if (event.key === "Escape" && !viewer.querySelector(".context-view-popover").hidden) {
      event.preventDefault()
      event.stopPropagation()
      viewer.querySelector(".context-view-popover").hidden = true
    }
  })
  viewer.querySelector(".context-prompt").addEventListener("focus", () => {
    if (viewer.composeCollapsed) setComposeCollapsed(viewer, false)
    viewer.querySelector(".context-model-popover").hidden = true
    viewer.querySelector(".context-view-popover").hidden = true
    closeThinkPicker(viewer)
    hideTuiPicker(viewer)
  })
  viewer.querySelector(".context-prompt").addEventListener("input", (event) => {
    autoGrowPrompt(event.target)
    hidePromptHistory(viewer)
    viewer.commandIndex = 0
    updateCommandMenu(viewer)
  })
  viewer.querySelector(".context-prompt").addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return
    const menu = viewer.querySelector(".context-command-popover")
    // 输入框为空时的 Ctrl/Cmd+Z：撤销上一步对话（弹窗确认），否则保留原生文本撤销。
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z" && !e.target.value.trim()) {
      e.preventDefault()
      e.stopPropagation()
      void undoLastStep(viewer)
      return
    }
    if (e.ctrlKey || e.metaKey) {
      // Keep native copy, paste, undo and redo behavior. Ctrl/Cmd+Enter remains send.
      if (e.key !== "Enter") return
    }
    const plainKey = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
    if (plainKey && !menu.hidden && viewer.historyIndex < 0 && !(e.key === "ArrowUp" && !e.target.value.trim())) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); hideCommandMenu(viewer); return }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        const count = viewer.commandChoices.length
        if (count) {
          viewer.commandIndex = (viewer.commandIndex + (e.key === "ArrowDown" ? 1 : -1) + count) % count
          updateCommandMenu(viewer)
          menu.querySelector("button.active")?.scrollIntoView({ block: "nearest" })
        }
        return
      }
      if (e.key === "Enter" && viewer.commandChoices.length) { e.preventDefault(); selectCommand(viewer, viewer.commandIndex); return }
    }
    if (plainKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const next = navigatePromptHistory(viewer.promptHistory ?? [], viewer.historyIndex, e.key, e.target.value, viewer.historyDraft)
      if (next) {
        e.preventDefault()
        viewer.historyDraft = next.draft
        if (next.index < 0) {
          const input = viewer.querySelector(".context-prompt")
          input.value = next.value
          input.focus()
          input.setSelectionRange(input.value.length, input.value.length)
          hidePromptHistory(viewer)
          updateCommandMenu(viewer)
        } else {
          setPromptHistoryValue(viewer, next.index)
        }
        return
      }
    }
    if (plainKey && e.key === "Escape" && viewer.historyIndex >= 0) {
      e.preventDefault()
      viewer.querySelector(".context-prompt").value = viewer.historyDraft
      hidePromptHistory(viewer)
      hideCommandMenu(viewer)
      return
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) { e.preventDefault(); sendContextMessage(viewer); return }
    if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
      const modes = ["build", "plan"].filter((name) => state.agents.some((item) => item.name === name))
      if (modes.length < 2 || viewer.settingsPending) return
      e.preventDefault()
      const current = viewer.sessionSettings?.agent ?? state.defaultAgent
      void setContextSetting(viewer, { agent: modes.find((mode) => mode !== current) }).catch(() => {})
    }
  })
  viewer.addEventListener("pointerdown", (event) => {
    const rect = viewer.getBoundingClientRect()
    if (tiledWindowPositions || viewer.classList.contains("maximized") || event.clientX < rect.right - 22 || event.clientY < rect.bottom - 22) return
    viewer.dataset.tiled = ""
    const finish = () => {
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", finish)
      if (!viewer.isConnected) return
      const next = viewer.getBoundingClientRect()
      if (Math.abs(next.width - rect.width) < 2 && Math.abs(next.height - rect.height) < 2) return
      localStorage.setItem("nodex.contextSize", JSON.stringify({ w: Math.round(next.width), h: Math.round(next.height), manual: true }))
    }
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", finish)
  })
  attachTitleBarDrag(viewer)
  attachWindowResize(viewer, {
    minWidth: 340,
    minHeight: 280,
    onStart: () => focusContextViewer(viewer),
    save: (w, h) => localStorage.setItem("nodex.contextSize", JSON.stringify({ w, h, manual: true })),
  })
}

// ---------------- 文件预览 ----------------
// 文件窗口尺寸按类型分别记忆：图片 / 音频 / 视频 / json / 代码 / 文本等各自独立。
const FILE_SIZE_EXT = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"],
  audio: ["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"],
  video: ["mp4", "webm", "mov", "mkv"],
  markdown: ["md", "markdown", "mdx"],
  html: ["html", "htm"],
  json: ["json"],
  jsonl: ["jsonl", "ndjson"],
  code: ["py", "ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "rb", "php", "swift", "sh", "bash", "zsh", "sql", "yml", "yaml", "toml", "ini", "css", "scss", "less", "xml", "vue", "svelte", "csv"],
}

function fileSizeCategory(path) {
  const ext = String(path).split(".").pop()?.toLowerCase() ?? ""
  for (const [category, exts] of Object.entries(FILE_SIZE_EXT)) if (exts.includes(ext)) return category
  return "text"
}

function fileSizeStoreKey(path) {
  return `nodex.fileSize.${fileSizeCategory(path)}`
}

function fileWindowSize(path) {
  const key = fileSizeStoreKey(path)
  let saved = null
  try { saved = JSON.parse(localStorage.getItem(key) || "null") } catch { saved = null }
  if (!saved) { try { saved = JSON.parse(localStorage.getItem("nodex.fileSize") || "null") } catch { saved = null } }
  const fallback = { w: Math.min(760, window.innerWidth - 60), h: Math.min(620, window.innerHeight - 140) }
  return {
    w: Math.min(Math.max(320, Number(saved?.w) || fallback.w), Math.max(320, window.innerWidth - 24)),
    h: Math.min(Math.max(240, Number(saved?.h) || fallback.h), Math.max(240, window.innerHeight - 24)),
  }
}

async function openFileViewer(path, ownerNode = null) {
  if (IS_VSCODE_HOST) return null
  let viewer = fileWindows.get(path)
  if (viewer) {
    focusContextViewer(viewer)
    showWindow(viewer)
    return viewer
  }
  viewer = fileTemplate.content.firstElementChild.cloneNode(true)
  viewer.dataset.path = path
  viewer.dataset.baseName = path.split("/").pop() || "文件"
  if (ownerNode) viewer.dataset.ownerNode = ownerNode
  viewer.querySelector(".file-viewer-name").textContent = viewer.dataset.baseName
  viewer.querySelector(".file-viewer-path").textContent = path
  viewer.querySelector(".file-viewer-body").innerHTML = '<div class="fv-note">加载中…</div>'
  const { w, h } = fileWindowSize(path)
  viewer.style.width = w + "px"
  viewer.style.height = h + "px"
  document.getElementById("app").append(viewer)
  fileWindows.set(path, viewer)
  viewer.classList.add("open")
  focusContextViewer(viewer)
  positionFileViewer(viewer)
  if (tiledWindowPositions) {
    tiledWindowPositions.set(viewer, {
      style: { left: viewer.style.left, top: viewer.style.top, width: viewer.style.width, height: viewer.style.height, zIndex: "" },
      maximized: false,
    })
    retileContextWindows()
  }
  attachFileViewer(viewer)
  applyTitleButtonConfig(viewer)
  updateTilingButtons()
  updatePinButtons()
  updatePersistButtons()
  await loadFileViewer(viewer, path)
  saveWindowSessionSoon()
  scheduleDraw()
  return viewer
}

async function loadFileViewer(viewer, path) {
  const nameEl = viewer.querySelector(".file-viewer-name")
  const pathEl = viewer.querySelector(".file-viewer-path")
  const bodyEl = viewer.querySelector(".file-viewer-body")
  try {
    const f = await api(`/file?path=${encodeURIComponent(path)}`)
    if (fileWindows.get(path) !== viewer) return
    viewer.dataset.baseName = f.name
    viewer.fileDirty = false
    nameEl.textContent = f.name
    viewer.classList.remove("file-dirty")
    pathEl.textContent = `${f.path}  ·  ${formatSize(f.size)}  ·  ${f.mime}`
    bodyEl.innerHTML = renderFileBody(f)
    mountFileExtras(viewer, f)
  } catch (error) {
    if (fileWindows.get(path) !== viewer) return
    nameEl.textContent = path.split("/").pop() || "文件"
    bodyEl.innerHTML = `<div class="fv-note">${escapeHtml(error.message)}</div>`
  }
}

/** 多开时窗口从左上角依次错开，避免完全叠在一起。 */
function positionFileViewer(viewer) {
  const rect = viewer.getBoundingClientRect()
  const w = rect.width, h = rect.height
  const index = fileWindows.size - 1
  const step = 30
  const left = clamp(48 + (index % 9) * step, 8, Math.max(8, window.innerWidth - w - 8))
  const top = clamp(74 + (index % 9) * step, 8, Math.max(8, window.innerHeight - h - 8))
  viewer.style.left = left + "px"
  viewer.style.top = top + "px"
}

/** 窗口标题栏：拖动移动、双击最大化 / 还原（供文件 / 会话 / 笔记本复用）。 */
function attachTitleBarDrag(viewer, selector = ".inspector-bar") {
  const bar = viewer.querySelector(selector)
  if (!bar) return
  bar.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, input")) return
    if (tiledWindowPositions && tileOrder.includes(viewer)) {
      if (tileLayout?.rects && tileLayout.mode === "stage") { focusContextViewer(viewer); return }
      startTileDrag(viewer, event)
      return
    }
    // 平铺降级为普通浮窗（windowUntiled）或本身就是浮窗时，走常规拖动。
    // 最大化窗口拖动时先还原成普通小窗，再跟随光标移动。
    event.preventDefault()
    const rect = viewer.getBoundingClientRect()
    let dx = event.clientX - rect.left
    let dy = event.clientY - rect.top
    const startX = event.clientX, startY = event.clientY
    let maximized = viewer.classList.contains("maximized")
    bar.classList.add("dragging")
    // 拖动期间禁用布局过渡，避免窗口“滞后”于光标。
    const previousTransition = viewer.style.transition
    viewer.style.transition = "none"
    try { bar.setPointerCapture(event.pointerId) } catch { /* 合成事件可能没有可捕获指针 */ }
    const move = (e) => {
      if (maximized) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) <= 4) return
        const restoreW = parseFloat(viewer.style.width) || rect.width
        const restoreH = parseFloat(viewer.style.height) || rect.height
        viewer.classList.remove("maximized")
        viewer.style.width = Math.round(restoreW) + "px"
        viewer.style.height = Math.round(restoreH) + "px"
        dx = clamp(dx, 0, Math.max(0, restoreW - 48))
        dy = clamp(dy, 0, 24)
        maximized = false
      }
      viewer.style.right = "auto"
      viewer.style.left = clamp(e.clientX - dx, 0, window.innerWidth - 48) + "px"
      viewer.style.top = clamp(e.clientY - dy, 0, window.innerHeight - 40) + "px"
      scheduleDraw()
    }
    const stop = () => {
      bar.classList.remove("dragging")
      viewer.style.transition = previousTransition
      bar.removeEventListener("pointermove", move)
      bar.removeEventListener("pointercancel", stop)
      if (!maximized) saveWindowSessionSoon()
    }
    bar.addEventListener("pointermove", move)
    bar.addEventListener("pointerup", stop, { once: true })
    bar.addEventListener("pointercancel", stop, { once: true })
  })
  bar.addEventListener("dblclick", (event) => {
    if (event.target.closest("button, input")) return
    toggleWindowMaximize(viewer)
  })
}

function toggleWindowMaximize(viewer) {
  const maximized = viewer.classList.contains("maximized")
  if (tiledWindowPositions) tileContextWindows()
  animateWindowLayout(() => viewer.classList.toggle("maximized", !maximized))
  scheduleDraw()
}

function attachFileViewer(viewer) {
  viewer.addEventListener("pointerdown", (event) => {
    if (!shouldSkipWindowFocus(viewer, event.target)) focusContextViewer(viewer)
  })
  // 编辑器失焦时也支持 Ctrl/Cmd+S 保存。
  viewer.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault()
      void saveFileEdit(viewer)
    }
  }, true)
  viewer.querySelector(".file-viewer-close").onclick = () => void closeFileViewer(viewer)
  viewer.querySelector(".file-viewer-pin").onclick = () => toggleWindowPin(viewer)
  viewer.querySelector(".file-viewer-persist").onclick = () => toggleWindowPersist(viewer)
  viewer.querySelector(".file-viewer-tile").onclick = tileContextWindows
  viewer.querySelector(".file-viewer-max").onclick = () => toggleWindowMaximize(viewer)
  viewer.querySelector(".file-viewer-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(viewer.dataset.path)
      statusEl.textContent = "已复制路径：" + viewer.dataset.path
    } catch {
      statusEl.textContent = "路径：" + viewer.dataset.path
    }
  }
  attachTitleBarDrag(viewer)
  attachWindowResize(viewer, {
    minWidth: 320,
    minHeight: 240,
    onStart: () => focusContextViewer(viewer),
    save: (w, h) => localStorage.setItem(fileSizeStoreKey(viewer.dataset.path), JSON.stringify({ w, h, manual: true })),
  })
}

function renderFileBody(f) {
  const truncated = f.truncated ? '<div class="fv-note">文件较大，仅显示前 512KB</div>' : ""
  if (f.encoding === "base64") {
    const src = `data:${f.mime};base64,${f.content}`
    if (f.kind === "image") return `<img src="${src}" alt="${escapeHtml(f.name)}" />`
    if (f.kind === "audio") return `<div class="fv-media" data-media="audio"><audio controls src="${src}"></audio><canvas class="fv-spectrum" width="900" height="140"></canvas></div>`
    if (f.kind === "video") return `<div class="fv-media" data-media="video"><video controls src="${src}"></video><canvas class="fv-spectrum" width="900" height="140"></canvas></div>`
    return `<div class="fv-note">二进制文件（${f.mime}）无法内联预览，可复制路径本地打开。</div>`
  }
  // Markdown 与 CSV / TSV 默认预览，可点击内容或标题栏按钮进入 Monaco 编辑。
  if (f.kind === "markdown") {
    return `${truncated}<div class="fv-md fv-md-preview">${renderMarkdown(f.content)}</div><div class="fv-code" hidden data-kind="markdown" data-lang="markdown"></div>`
  }
  if (isCsvFile(f.path)) {
    const delim = csvDelimiter(f.path)
    return `${truncated}<div class="fv-table-preview fv-csv-wrap">${renderCsvTable(f.content, delim)}</div><div class="fv-code" hidden data-kind="csv" data-lang="plaintext"></div>`
  }
  // 其余文本类（含 HTML / JSON / 普通代码）统一用 Monaco 直接编辑，行为对齐 VSCode。
  return `${truncated}<div class="fv-code" data-kind="${f.kind}" data-lang="${escapeHtml(monacoLanguageOf(f.path))}"></div>`
}

function isCsvFile(path) {
  const ext = String(path).split(".").pop()?.toLowerCase() ?? ""
  return ext === "csv" || ext === "tsv"
}

function csvDelimiter(path) {
  return String(path).split(".").pop()?.toLowerCase() === "tsv" ? "\t" : ","
}

/** 极简 CSV / TSV 解析：支持双引号包裹、内嵌分隔符与转义引号。 */
function parseCsv(text, delimiter) {
  const rows = []
  let row = []
  let field = ""
  let quoted = false
  const pushField = () => { row.push(field); field = "" }
  const pushRow = () => { pushField(); rows.push(row); row = [] }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === delimiter) { pushField(); continue }
    if (ch === "\n") { pushRow(); continue }
    if (ch === "\r") { if (text[i + 1] === "\n") i++; pushRow(); continue }
    field += ch
  }
  if (field || row.length) pushRow()
  return rows
}

function renderCsvTable(text, delimiter) {
  const rows = parseCsv(text, delimiter)
  if (!rows.length) return '<div class="fv-note">空文件</div>'
  const limit = 2000
  const head = rows[0]
  const body = rows.slice(1, limit)
  const th = head.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")
  const trs = body.map((cells) => `<tr>${head.map((_, index) => `<td>${escapeHtml(cells[index] ?? "")}</td>`).join("")}</tr>`).join("")
  const more = rows.length > limit ? `<div class="fv-note">仅显示前 ${limit} 行（共 ${rows.length - 1} 行）</div>` : ""
  return `<table class="fv-csv"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>${more}`
}

// ---------------- Monaco 编辑器（代码 / JSON / 文本预览与编辑） ----------------
const MONACO_LANG_BY_EXT = {
  py: "python", pyw: "python", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", java: "java", kt: "kotlin", go: "go", rs: "rust", rb: "ruby",
  php: "php", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cs: "csharp",
  sh: "shell", bash: "shell", zsh: "shell", sql: "sql", yml: "yaml", yaml: "yaml", toml: "ini",
  ini: "ini", css: "css", scss: "scss", less: "less", xml: "xml", svg: "xml", vue: "html",
  svelte: "html", md: "markdown", markdown: "markdown", json: "json", jsonl: "json", ndjson: "json",
  html: "html", htm: "html", csv: "plaintext", tsv: "plaintext", log: "plaintext",
}

function monacoLanguageOf(path) {
  const ext = String(path).split(".").pop()?.toLowerCase() ?? ""
  return MONACO_LANG_BY_EXT[ext] ?? "plaintext"
}

let monacoReady = null
function loadMonaco() {
  if (monacoReady) return monacoReady
  monacoReady = new Promise((resolve, reject) => {
    if (window.monaco?.editor) { resolve(window.monaco); return }
    window.MonacoEnvironment = {
      // AMD 版 Monaco：所有语言 worker 都通过通用 bootstrap 加载。
      getWorkerUrl() { return "/vendor/monaco/vs/base/worker/workerMain.js" },
    }
    const script = document.createElement("script")
    script.src = "/vendor/monaco/vs/loader.js"
    script.onload = () => {
      const req = window.require
      if (!req) { reject(new Error("Monaco loader 未就绪")); return }
      req.config({ paths: { vs: "/vendor/monaco/vs" } })
      req(["vs/editor/editor.main"], () => resolve(window.monaco), reject)
    }
    script.onerror = () => reject(new Error("Monaco 资源加载失败"))
    document.head.append(script)
  })
  return monacoReady
}

async function mountCodeEditor(viewer, el, f) {
  try {
    const monaco = await loadMonaco()
    if (!el.isConnected) return
    viewer.fileOriginal = f.content
    viewer.fileDirty = false
    // 只显示前 512KB 的截断文件不可编辑，避免保存时截断丢失内容。
    const editable = !f.truncated
    const editor = monaco.editor.create(el, {
      value: f.content,
      language: el.dataset.lang || "plaintext",
      theme: isLightTheme() ? "vs" : "vs-dark",
      readOnly: !editable,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      folding: true,
      wordWrap: "on",
      fontSize: 12,
      renderWhitespace: "selection",
      smoothScrolling: true,
    })
    viewer.fileEditor = editor
    wireFileSelMenu(viewer, editor)
    if (editable) {
      editor.onDidChangeModelContent(() => {
        const dirty = editor.getValue() !== viewer.fileOriginal
        if (dirty === viewer.fileDirty) return
        viewer.fileDirty = dirty
        updateFileDirtyIndicator(viewer)
      })
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void saveFileEdit(viewer) })
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, () => { editor.trigger("toolbar", "undo", null) })
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ, () => { editor.trigger("toolbar", "redo", null) })
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () => { editor.trigger("toolbar", "redo", null) })
      editor.focus()
    }
  } catch (error) {
    el.innerHTML = `<pre>${escapeHtml(f.content)}</pre>`
    statusEl.textContent = "编辑器加载失败，已回退为纯文本：" + error.message
  }
}

// ---------------- 文件编辑器划选菜单（与笔记本同款） ----------------
function hideFileSelMenu(viewer) {
  const menu = viewer.querySelector(".file-sel-menu")
  if (menu) { menu.hidden = true; menu.innerHTML = "" }
}

function fileSelShortcutsHtml(shortcuts) {
  return shortcuts.map((item, index) => `<button type="button" data-file-custom="${index}" title="${escapeHtml(item.instruction)}">${escapeHtml(item.name)}</button>`).join("")
}

function showFileSelMenu(viewer, point) {
  const menu = viewer.querySelector(".file-sel-menu")
  const editor = viewer.fileEditor
  if (!menu || !editor) return
  const selection = editor.getSelection()
  const text = selection ? editor.getModel().getValueInRange(selection) : ""
  if (!selection || !text.trim()) { hideFileSelMenu(viewer); return }
  viewer.fileSelRange = selection
  const shortcuts = loadNbRewriteShortcuts()
  menu.hidden = false
  menu.innerHTML = `
    <div class="nb-sel-actions">
      <button type="button" data-file-sel="copy">复制</button>
      <button type="button" data-file-sel="cut">剪切</button>
      <button type="button" data-file-quick="摘要">摘要</button>
      <button type="button" data-file-quick="翻译成中文">翻译成中文</button>
      <button type="button" data-file-quick="翻译成英文">翻译成英文</button>
      ${fileSelShortcutsHtml(shortcuts)}
      <button type="button" data-file-add-shortcut title="添加改写快捷键">＋</button>
    </div>
    <div class="nb-sel-rewrite">
      <textarea class="nb-rewrite-input" rows="1" placeholder="AI 改写指令，如：更简洁 / 翻译成英文"></textarea>
      <button type="button" data-file-sel="node">对话</button>
      <button type="button" class="nb-rewrite-go primary">改写</button>
    </div>
  `
  const rect = viewer.getBoundingClientRect()
  const x = point ? point.x - rect.left : 12
  const y = point ? point.y - rect.top + 8 : 12
  menu.style.left = clamp(x, 8, Math.max(8, viewer.clientWidth - menu.offsetWidth - 8)) + "px"
  menu.style.top = clamp(y, 8, Math.max(8, viewer.clientHeight - menu.offsetHeight - 8)) + "px"
  menu.querySelector('[data-file-sel="copy"]').onclick = async () => {
    const value = editor.getModel().getValueInRange(viewer.fileSelRange)
    const ok = await copyTextToClipboard(value)
    statusEl.textContent = ok ? "已复制选中文本" : "复制失败，请手动复制"
    hideFileSelMenu(viewer)
  }
  menu.querySelector('[data-file-sel="cut"]').onclick = async () => {
    const value = editor.getModel().getValueInRange(viewer.fileSelRange)
    await copyTextToClipboard(value)
    editor.executeEdits("file-sel", [{ range: viewer.fileSelRange, text: "" }])
    editor.pushUndoStop()
    hideFileSelMenu(viewer)
    statusEl.textContent = "已剪切选中文本"
  }
  menu.querySelector('[data-file-sel="node"]').onclick = async () => {
    const value = editor.getModel().getValueInRange(viewer.fileSelRange)
    hideFileSelMenu(viewer)
    if (!value.trim()) return
    try {
      const title = `摘录：${value.slice(0, 12).replace(/\n/g, " ")}`
      const node = await api("/nodes", {
        method: "POST",
        body: JSON.stringify({
          title,
          seed: `【摘录自「${viewer.dataset.baseName || "文件"}」】\n\n${value}\n\n（以上为背景资料，请在此基础上继续。）`,
          workspaceId: state.activeWs || undefined,
          model: currentModel(),
          provisionalTitle: true,
        }),
      })
      await refresh()
      select({ type: "node", id: node.id })
      statusEl.textContent = `已用选中文本新建对话节点「${title}」`
    } catch (error) {
      statusEl.textContent = "新建失败: " + error.message
    }
  }
  const rewriteInput = menu.querySelector(".nb-rewrite-input")
  const run = () => { void runFileRewrite(viewer, rewriteInput.value.trim()) }
  menu.querySelector(".nb-rewrite-go").onclick = run
  const runInstruction = (instruction) => {
    rewriteInput.value = instruction
    void runFileRewrite(viewer, instruction)
  }
  menu.querySelectorAll("[data-file-quick]").forEach((button) => {
    button.onclick = () => runInstruction(NB_QUICK_INSTRUCTIONS[button.dataset.fileQuick] || button.dataset.fileQuick)
  })
  menu.querySelectorAll("[data-file-custom]").forEach((button) => {
    button.onclick = () => {
      const item = loadNbRewriteShortcuts()[Number(button.dataset.fileCustom)]
      if (item) runInstruction(item.instruction)
    }
  })
  menu.querySelector("[data-file-add-shortcut]").onclick = async () => {
    const nameResult = await fsPrompt({ title: "添加快捷键", label: "按钮名称", value: "" })
    if (!nameResult.ok || !nameResult.name) return
    const insResult = await fsPrompt({ title: "添加快捷键", label: "改写指令", value: "" })
    if (!insResult.ok || !insResult.name) return
    const list = loadNbRewriteShortcuts()
    list.push({ name: nameResult.name, instruction: insResult.name })
    saveNbRewriteShortcuts(list)
    showFileSelMenu(viewer, viewer.fileSelPoint)
  }
  rewriteInput.addEventListener("mousedown", (event) => event.stopPropagation())
  const autoGrow = () => {
    rewriteInput.style.height = "auto"
    rewriteInput.style.height = Math.min(rewriteInput.scrollHeight, 72) + "px"
  }
  rewriteInput.addEventListener("input", autoGrow)
  rewriteInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); run() }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hideFileSelMenu(viewer); editor.focus() }
  })
}

async function runFileRewrite(viewer, instruction) {
  const editor = viewer.fileEditor
  const range = viewer.fileSelRange
  if (!editor || !range) return
  const text = editor.getModel().getValueInRange(range)
  if (!text.trim()) return
  const menu = viewer.querySelector(".file-sel-menu")
  const go = menu.querySelector(".nb-rewrite-go")
  if (go) { go.disabled = true; go.textContent = "改写中…" }
  try {
    const result = await api("/ai/rewrite", {
      method: "POST",
      body: JSON.stringify({ text, instruction: instruction || "在保持原意的前提下润色，使表达更清晰" }),
      timeout: 120000,
    })
    const next = typeof result.text === "string" ? result.text : ""
    if (!next) throw new Error("模型未返回内容")
    editor.executeEdits("file-rewrite", [{ range, text: next }])
    editor.pushUndoStop()
    hideFileSelMenu(viewer)
    editor.focus()
    statusEl.textContent = "已用 AI 改写选中文本"
  } catch (error) {
    if (go) { go.disabled = false; go.textContent = "改写" }
    statusEl.textContent = "AI 改写失败: " + error.message
  }
}

function wireFileSelMenu(viewer, editor) {
  editor.onMouseUp((event) => {
    const selection = editor.getSelection()
    if (!selection || selection.isEmpty()) { hideFileSelMenu(viewer); return }
    viewer.fileSelPoint = { x: event.event.posx, y: event.event.posy }
    showFileSelMenu(viewer, viewer.fileSelPoint)
  })
  editor.onMouseDown(() => hideFileSelMenu(viewer))
  editor.onDidScrollChange(() => hideFileSelMenu(viewer))
  editor.onDidChangeModelContent(() => hideFileSelMenu(viewer))
}

/** 标题栏显示未保存标记（●），与 VSCode 一致。 */
function updateFileDirtyIndicator(viewer) {
  const nameEl = viewer.querySelector(".file-viewer-name")
  if (!nameEl) return
  const base = viewer.dataset.baseName || "文件"
  nameEl.textContent = viewer.fileDirty ? `${base} ●` : base
  viewer.classList.toggle("file-dirty", Boolean(viewer.fileDirty))
}

async function saveFileEdit(viewer) {
  const editor = viewer.fileEditor
  if (!editor) return false
  const content = editor.getValue()
  try {
    await api("/file", { method: "PUT", body: JSON.stringify({ path: viewer.dataset.path, content }) })
    viewer.fileOriginal = content
    viewer.fileDirty = false
    if (viewer.fileData) viewer.fileData.content = content
    updateFileDirtyIndicator(viewer)
    statusEl.textContent = "已保存：" + viewer.dataset.path
    return true
  } catch (error) {
    statusEl.textContent = "保存失败: " + error.message
    return false
  }
}

// ---------------- 音频 / 视频波形可视化 ----------------
function attachMediaSpectrum(media, canvas) {
  const draw2d = canvas.getContext("2d")
  let audioCtx = null, analyser = null, data = null, raf = null
  const ensure = () => {
    if (audioCtx) return
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return
    audioCtx = new AC()
    const source = audioCtx.createMediaElementSource(media)
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)
    analyser.connect(audioCtx.destination)
    data = new Uint8Array(analyser.fftSize)
  }
  const render = () => {
    const w = canvas.width, h = canvas.height
    const light = isLightTheme()
    draw2d.clearRect(0, 0, w, h)
    const mid = h / 2
    // 中线
    draw2d.strokeStyle = light ? "rgba(100,116,139,.35)" : "rgba(139,156,255,.28)"
    draw2d.lineWidth = 1
    draw2d.beginPath(); draw2d.moveTo(0, mid); draw2d.lineTo(w, mid); draw2d.stroke()
    // 波形（时域）
    if (analyser && data) {
      analyser.getByteTimeDomainData(data)
      draw2d.strokeStyle = light ? "#4f46e5" : "#8b9cff"
      draw2d.lineWidth = 1.6
      draw2d.beginPath()
      const n = data.length
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w
        const y = mid + ((data[i] - 128) / 128) * (h * 0.42)
        if (i === 0) draw2d.moveTo(x, y)
        else draw2d.lineTo(x, y)
      }
      draw2d.stroke()
    }
    // 播放进度竖线：随时间从左到右遍历
    const dur = media.duration
    if (dur && Number.isFinite(dur) && dur > 0) {
      const x = clamp(media.currentTime / dur, 0, 1) * w
      draw2d.strokeStyle = light ? "#dc2626" : "#f87171"
      draw2d.lineWidth = 2
      draw2d.beginPath(); draw2d.moveTo(x, 0); draw2d.lineTo(x, h); draw2d.stroke()
    }
  }
  const loop = () => {
    raf = null
    render()
    if (!media.paused && !media.ended) raf = requestAnimationFrame(loop)
  }
  const start = () => {
    try { ensure() } catch { /* 某些环境下无法建立音频图，忽略 */ }
    audioCtx?.resume?.().catch(() => {})
    if (!raf) loop()
  }
  const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = null } render() }
  media.addEventListener("play", start)
  media.addEventListener("pause", stop)
  media.addEventListener("ended", stop)
  media.addEventListener("timeupdate", render)
  media.addEventListener("seeked", render)
  media.addEventListener("loadedmetadata", render)
  render()
  const viewer = fileWindows.get(media.closest(".file-viewer")?.dataset.path)
  if (viewer) viewer.stopMediaSpectrum = () => { stop(); audioCtx?.close?.().catch(() => {}) }
}

function mountFileExtras(viewer, f) {
  viewer.fileData = f
  viewer.fileEditor = null
  viewer.fileViewMode = "preview"
  viewer.filePreviewEl = null
  viewer.fileCodeEl = null
  const codeEl = viewer.querySelector(".fv-code")
  const preview = viewer.querySelector(".fv-md-preview, .fv-table-preview")
  const mediaWrap = viewer.querySelector(".fv-media")
  const viewBtn = viewer.querySelector(".file-viewer-view")
  const toggleable = Boolean(codeEl && preview)
  if (viewBtn) {
    viewBtn.hidden = !toggleable
    if (toggleable) {
      viewBtn.textContent = "编辑"
      viewBtn.title = "切换预览 / 编辑"
      viewBtn.setAttribute("aria-pressed", "false")
      viewBtn.onclick = () => setFileViewMode(viewer, viewer.fileViewMode === "edit" ? "preview" : "edit")
    }
  }
  if (toggleable) {
    viewer.filePreviewEl = preview
    viewer.fileCodeEl = codeEl
    // 点击预览正文进入编辑；标题栏「编辑 / 预览」按钮可随时切回。
    preview.addEventListener("click", () => setFileViewMode(viewer, "edit"))
    return
  }
  if (codeEl) {
    void mountCodeEditor(viewer, codeEl, f)
  } else if (mediaWrap) {
    const media = mediaWrap.querySelector("audio, video")
    const canvas = mediaWrap.querySelector(".fv-spectrum")
    if (media && canvas) attachMediaSpectrum(media, canvas)
  }
}

/** 用编辑器的当前内容刷新预览（Markdown 重新渲染 / CSV 重新建表）。 */
function refreshFilePreviewContent(viewer, content) {
  const preview = viewer.filePreviewEl
  if (!preview) return
  if (viewer.fileData?.kind === "markdown") preview.innerHTML = renderMarkdown(content)
  else if (isCsvFile(viewer.dataset.path)) preview.innerHTML = renderCsvTable(content, csvDelimiter(viewer.dataset.path))
}

/** 在「预览」与「Monaco 编辑」之间切换（Markdown / CSV / TSV）。 */
function setFileViewMode(viewer, mode) {
  const codeEl = viewer.fileCodeEl
  const preview = viewer.filePreviewEl
  if (!codeEl || !preview) return
  if (mode === "edit") {
    preview.hidden = true
    codeEl.hidden = false
    viewer.fileViewMode = "edit"
    if (!viewer.fileEditor) void mountCodeEditor(viewer, codeEl, viewer.fileData)
    else { viewer.fileEditor.layout?.(); viewer.fileEditor.focus() }
  } else {
    if (viewer.fileEditor) refreshFilePreviewContent(viewer, viewer.fileEditor.getValue())
    codeEl.hidden = true
    preview.hidden = false
    viewer.fileViewMode = "preview"
  }
  const btn = viewer.querySelector(".file-viewer-view")
  if (btn) {
    const editing = viewer.fileViewMode === "edit"
    btn.textContent = editing ? "预览" : "编辑"
    btn.setAttribute("aria-pressed", String(editing))
  }
}

/** 关闭文件窗：有未保存修改时先询问是否保存。force 跳过询问。返回是否已关闭。 */
async function closeFileViewer(viewer, { force = false } = {}) {
  if (!viewer) return false
  if (!force && viewer.fileDirty) {
    const name = viewer.dataset.baseName || viewer.dataset.path
    const { ok, alt } = await confirmAction({
      title: "保存更改？",
      text: `「${name}」有未保存的修改。`,
      action: "保存",
      alt: "不保存",
    })
    if (!ok && !alt) return false
    if (ok && !(await saveFileEdit(viewer))) return false
  }
  try { viewer.stopMediaSpectrum?.() } catch { /* 忽略释放失败 */ }
  try { viewer.fileEditor?.dispose?.() } catch { /* 忽略释放失败 */ }
  fileWindows.delete(viewer.dataset.path)
  tiledWindowPositions?.delete(viewer)
  tileOrder = tileOrder.filter((item) => item !== viewer)
  viewer.remove()
  if (tiledWindowPositions) retileContextWindows()
  saveWindowSessionSoon()
  scheduleDraw()
  return true
}

// ---------------- 本地目录浏览 ----------------
const fsPanel = document.getElementById("fsPanel")
const fsTreeEl = fsPanel.querySelector(".fs-tree")
const fsPathEl = fsPanel.querySelector(".fs-path")
const fsStatusEl = fsPanel.querySelector(".fs-status")
const fsState = { mode: "global", currentPath: null, root: null, selected: new Set(), anchor: null, expanded: new Set(), dirCache: new Map() }
// 目录树剪贴板：复制 / 剪切待粘贴的路径（支持多选）。
const fsClipboard = { mode: null, paths: [] }

function fsSetStatus(text, isError = false) {
  fsStatusEl.textContent = text
  fsStatusEl.classList.toggle("error", isError)
}

function fsActiveWorkspace() {
  return state.graph.workspaces.find((ws) => ws.id === state.activeWs) ?? null
}

function fsSyncDirInput() {
  const input = fsPanel.querySelector("#fsDirInput")
  if (!input) return
  const ws = fsActiveWorkspace()
  input.disabled = !ws
  input.placeholder = ws ? `当前页面「${ws.name}」的工作区目录（绝对路径）` : "请先在顶部选择一个页面"
  if (document.activeElement !== input) input.value = ws?.dir ?? ""
}

async function fsSetWorkspaceDir(dir) {
  if (!state.activeWs) {
    fsSetStatus("请先在顶部选择一个页面，再设置工作区目录", true)
    return
  }
  const value = typeof dir === "string" ? dir.trim() : ""
  try {
    await api(`/workspaces/${state.activeWs}`, { method: "PATCH", body: JSON.stringify({ dir: value || null }) })
    await refresh()
    await reloadFsTree()
    fsSetStatus(value ? `已设置工作区目录：${value}` : "已清除工作区目录")
  } catch (error) {
    fsSetStatus(`设置失败: ${error.message}`, true)
  }
}

/** 把文件/目录路径写入文本框光标处，并触发 input 以复用自动增高 / 保存逻辑。 */
function insertPathAtCursor(textarea, path) {
  if (!textarea) return false
  const text = textarea.value && !textarea.value.endsWith("\n") ? `\n${path}` : path
  const start = textarea.selectionStart ?? textarea.value.length
  const end = textarea.selectionEnd ?? start
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end)
  const caret = start + text.length
  textarea.selectionStart = textarea.selectionEnd = caret
  textarea.dispatchEvent(new Event("input", { bubbles: true }))
  textarea.focus()
  return true
}

/** 允许把目录树中的文件 / 目录拖到窗口正文，路径写入指定文本框。 */
function enablePathDrop(viewer, resolveTextarea) {
  const droppedPath = (event) => (event.dataTransfer?.getData("text/plain") || "").trim()
  viewer.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types?.includes("text/plain")) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
  })
  viewer.addEventListener("drop", (event) => {
    const path = droppedPath(event)
    if (!path) return
    // 直接落在文本框上时交给浏览器原生插入，避免重复写入。
    if (event.target instanceof Element && event.target.closest("textarea")) return
    const textarea = resolveTextarea(event)
    if (!textarea) return
    event.preventDefault()
    insertPathAtCursor(textarea, path)
    statusEl.textContent = `已插入路径：${path}`
  })
}

function updateFsButton() {
  const button = document.getElementById("fsBrowserBtn")
  if (button) button.setAttribute("aria-pressed", String(!fsPanel.hidden))
}

// ---------------- 目录树右键菜单：复制 / 剪切 / 粘贴 / 下载 / 重命名 / 删除 ----------------
const fsMenu = document.getElementById("fsMenu")
const fsPromptDialog = document.getElementById("fsPromptDialog")

function fsBasename(p) {
  const value = String(p ?? "").replace(/\/+$/, "")
  const idx = value.lastIndexOf("/")
  return idx < 0 ? value : value.slice(idx + 1)
}

function fsDirname(p) {
  const value = String(p ?? "").replace(/\/+$/, "")
  const idx = value.lastIndexOf("/")
  return idx <= 0 ? "/" : value.slice(0, idx)
}

function fsRelativePath(p) {
  const root = fsState.root
  const value = String(p ?? "")
  if (root && (value === root || value.startsWith(root + "/"))) return value.slice(root.length + 1) || "."
  return value
}

async function fsOp(path, body) {
  const data = await api(path, { method: "POST", body: JSON.stringify(body), timeout: 30000 })
  return data
}

function fsPrompt({ title = "重命名", label = "名称", value = "" } = {}) {
  fsPromptDialog.querySelector("#fsPromptTitle").textContent = title
  fsPromptDialog.querySelector("#fsPromptLabel").textContent = label
  const input = fsPromptDialog.querySelector("#fsPromptInput")
  input.value = value
  fsPromptDialog.querySelector("#fsPromptError").textContent = ""
  fsPromptDialog.returnValue = "cancel"
  fsPromptDialog.showModal()
  input.focus()
  input.select()
  return new Promise((resolve) => fsPromptDialog.addEventListener("close", () => {
    resolve({ ok: fsPromptDialog.returnValue === "confirm", name: input.value.trim() })
  }, { once: true }))
}

fsPromptDialog.querySelector("form").addEventListener("submit", (event) => {
  event.preventDefault()
  const input = fsPromptDialog.querySelector("#fsPromptInput")
  const name = input.value.trim()
  if (!name) {
    fsPromptDialog.querySelector("#fsPromptError").textContent = "请输入名称"
    input.focus()
    return
  }
  fsPromptDialog.close("confirm")
})
fsPromptDialog.querySelector("#fsPromptCancel").onclick = () => fsPromptDialog.close("cancel")

async function fsClipboardWrite(text) {
  try {
    await navigator.clipboard.writeText(text)
    fsSetStatus(`已复制：${text}`)
  } catch {
    fsSetStatus(`路径：${text}`)
  }
}

function hideFsMenu() {
  fsMenu.hidden = true
}

/** 打开目录树右键菜单。target: { path, type } 或 { dir }（空白处）。 */
function openFsMenu(event, target) {
  const isEntry = Boolean(target?.path)
  const isDir = isEntry ? target?.type === "dir" : true
  const dir = isEntry ? (isDir ? target.path : fsDirname(target.path)) : (target?.dir ?? fsState.currentPath)
  fsMenu.dataset.path = isEntry ? target.path : ""
  fsMenu.dataset.type = isEntry ? target.type : "dir"
  fsMenu.dataset.dir = dir ?? ""
  const selectedCount = fsSelectedPaths().length
  fsMenu.querySelector("#fsMenuTitle").textContent = isEntry
    ? (selectedCount > 1 ? `${selectedCount} 项` : fsBasename(target.path))
    : "当前目录"
  const show = (id, visible) => { fsMenu.querySelector(id).hidden = !visible }
  show("#fsMenuCopy", isEntry)
  show("#fsMenuCut", isEntry)
  show("#fsMenuRename", isEntry)
  show("#fsMenuDelete", isEntry)
  show("#fsMenuCopyPath", isEntry)
  show("#fsMenuCopyRel", isEntry)
  show("#fsMenuDownload", isEntry && !isDir)
  show("#fsMenuPaste", Boolean(fsClipboard.mode && dir))
  show("#fsMenuNewFile", isDir)
  show("#fsMenuNewDir", isDir)
  fsMenu.hidden = false
  const rect = fsMenu.getBoundingClientRect()
  fsMenu.style.left = clamp(event.clientX, 6, Math.max(6, window.innerWidth - rect.width - 6)) + "px"
  fsMenu.style.top = clamp(event.clientY, 6, Math.max(6, window.innerHeight - rect.height - 6)) + "px"
  event.preventDefault()
  event.stopPropagation()
}

async function fsPaste() {
  if (!fsClipboard.mode || !fsClipboard.paths.length) return
  const dir = fsMenu.dataset.dir
  if (!dir) return
  await fsPasteInto(dir)
}

function fsCopy() {
  fsCopySelection()
}

async function fsCut() {
  await fsCutSelection()
}


fsMenu.querySelector("#fsMenuPaste").onclick = () => { hideFsMenu(); void fsPaste() }
fsMenu.querySelector("#fsMenuCopy").onclick = () => { hideFsMenu(); fsCopy() }
fsMenu.querySelector("#fsMenuCut").onclick = () => { hideFsMenu(); void fsCut() }
fsMenu.querySelector("#fsMenuDownload").onclick = () => {
  const path = fsMenu.dataset.path
  hideFsMenu()
  const a = document.createElement("a")
  a.href = `/api/fs/download?path=${encodeURIComponent(path)}`
  a.download = fsBasename(path)
  document.body.append(a)
  a.click()
  a.remove()
}
fsMenu.querySelector("#fsMenuCopyPath").onclick = () => {
  const paths = fsSelectedPaths()
  const text = paths.length > 1 ? paths.join("\n") : fsMenu.dataset.path
  hideFsMenu()
  void fsClipboardWrite(text)
}
fsMenu.querySelector("#fsMenuCopyRel").onclick = () => {
  const paths = fsSelectedPaths()
  const text = paths.length > 1 ? paths.map((p) => fsRelativePath(p)).join("\n") : fsRelativePath(fsMenu.dataset.path)
  hideFsMenu()
  void fsClipboardWrite(text)
}
fsMenu.querySelector("#fsMenuRename").onclick = () => {
  const path = fsMenu.dataset.path
  hideFsMenu()
  void fsRenameSelection(path)
}
fsMenu.querySelector("#fsMenuNewFile").onclick = async () => {
  const dir = fsMenu.dataset.dir
  hideFsMenu()
  const { ok, name } = await fsPrompt({ title: "新建文件", label: "文件名", value: "untitled.txt" })
  if (!ok || !name) return
  try {
    await fsOp("/fs/create", { dir, name })
    await reloadFsTree()
    fsSetStatus(`已新建文件：${name}`)
  } catch (error) {
    fsSetStatus(`新建文件失败: ${error.message}`, true)
  }
}
fsMenu.querySelector("#fsMenuNewDir").onclick = async () => {
  const dir = fsMenu.dataset.dir
  hideFsMenu()
  const { ok, name } = await fsPrompt({ title: "新建目录", label: "目录名", value: "new-folder" })
  if (!ok || !name) return
  try {
    await fsOp("/fs/mkdir", { dir, name })
    await reloadFsTree()
    fsSetStatus(`已新建目录：${name}`)
  } catch (error) {
    fsSetStatus(`新建目录失败: ${error.message}`, true)
  }
}
fsMenu.querySelector("#fsMenuDelete").onclick = () => { hideFsMenu(); void fsDeleteSelection() }

document.addEventListener("pointerdown", (event) => {
  if (!fsMenu.hidden && !fsMenu.contains(event.target)) hideFsMenu()
})
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !fsMenu.hidden) hideFsMenu()
})

async function fsUndoLast() {
  try {
    const result = await fsOp("/fs/undo", {})
    await reloadFsTree()
    fsSetStatus(`已撤回：${fsBasename(result.path ?? "")}`)
  } catch (error) {
    fsSetStatus(`撤回失败: ${error.message}`, true)
  }
}
fsPanel.querySelector("#fsUndo").onclick = () => void fsUndoLast()

// 目录树空白处右键：粘贴 / 新建
fsTreeEl.addEventListener("contextmenu", (event) => {
  if (event.target.closest(".fs-row")) return
  openFsMenu(event, { dir: fsState.currentPath })
})

function openFsPanel() {
  if (IS_VSCODE_HOST) return
  fsPanel.hidden = false
  fsPanel.style.zIndex = fsPanel.dataset.mode === "window" ? "46" : "7"
  updateFsButton()
  updateMaximizedVars()
  if (tiledWindowPositions) retileContextWindows()
  void reloadFsTree()
}

function closeFsPanel() {
  fsPanel.hidden = true
  hideFsMenu()
  updateFsButton()
  updateMaximizedVars()
  if (tiledWindowPositions) retileContextWindows()
}

function setFsMode(mode) {
  fsState.mode = mode
  fsPanel.querySelectorAll("[data-fs-mode]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.fsMode === mode))
  })
  if (tiledWindowPositions) retileContextWindows()
  void reloadFsTree()
}

async function reloadFsTree() {
  fsSetStatus("")
  fsSyncDirInput()
  // 已有内容时不清空（避免刷新时闪一下空白），仅首次加载显示占位。
  if (!fsTreeEl.querySelector(".fs-row")) fsTreeEl.innerHTML = '<div class="muted">加载中…</div>'
  if (fsState.mode === "workspace") await renderFsWorkspace()
  else await renderFsGlobal()
}

async function renderFsGlobal() {
  fsPanel.querySelector("#fsBindDir").hidden = !state.activeWs
  fsPanel.querySelector("#fsClearDir").hidden = true
  try {
    const payload = await api("/fs/list")
    fsState.root = payload.root
    fsPanel.querySelector(".fs-root").textContent = payload.root
    renderFsTree(fsTreeEl, payload)
  } catch (error) {
    fsTreeEl.innerHTML = `<div class="msg error">${escapeHtml(error.message)}</div>`
  }
}

async function renderFsWorkspace() {
  fsPanel.querySelector("#fsBindDir").hidden = true
  if (!state.activeWs) {
    fsPanel.querySelector(".fs-root").textContent = ""
    fsTreeEl.innerHTML = '<div class="muted">当前没有选中的页面</div>'
    return
  }
  let payload
  try {
    payload = await api(`/fs/workspace/${state.activeWs}/files`)
  } catch (error) {
    fsTreeEl.innerHTML = `<div class="msg error">${escapeHtml(error.message)}</div>`
    return
  }
  if (payload.dir) {
    fsPanel.querySelector("#fsClearDir").hidden = false
    fsPanel.querySelector(".fs-root").textContent = payload.dir
    try {
      const listing = await api(`/fs/list?path=${encodeURIComponent(payload.dir)}`)
      fsState.root = listing.root
      renderFsTree(fsTreeEl, listing)
    } catch (error) {
      fsTreeEl.innerHTML = `<div class="msg error">${escapeHtml(error.message)}</div>`
    }
    return
  }
  fsPanel.querySelector("#fsClearDir").hidden = true
  fsPanel.querySelector(".fs-root").textContent = payload.root
  fsPathEl.innerHTML = '<span class="muted">本页节点引用过的文件（可在「全局」中浏览并绑定目录）</span>'
  const files = payload.files ?? []
  if (!files.length) {
    fsTreeEl.innerHTML = '<div class="muted">本页暂无引用文件</div>'
    return
  }
  fsTreeEl.innerHTML = files
    .map((file) => `<div class="fs-row fs-file ${file.exists ? "" : "missing"}" draggable="true" data-path="${escapeHtml(file.path)}" title="${escapeHtml(file.path)}（可拖到输入框或笔记本插入路径）"><span class="fs-caret"></span><span class="fs-icon">📄</span><span class="fs-name">${escapeHtml(file.rel)}</span><span class="fs-meta">${escapeHtml(file.direction === "output" ? "输出" : file.direction === "input" ? "输入" : "")}</span></div>`)
    .join("")
  fsTreeEl.querySelectorAll(".fs-file").forEach((el) => {
    el.dataset.type = "file"
    el.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey) { toggleFsSelect(el.dataset.path); return }
      if (event.shiftKey) { selectFsRange(el.dataset.path); return }
      selectFsOnly(el.dataset.path)
    })
    el.addEventListener("dblclick", () => openFileViewer(el.dataset.path))
    el.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", el.dataset.path)
      event.dataTransfer.effectAllowed = "copy"
    })
    el.addEventListener("contextmenu", (event) => openFsMenu(event, { path: el.dataset.path, type: "file" }))
  })
  applyFsSelection()
}

// ---------------- 目录树多选 / 键盘操作（对齐 VSCode） ----------------

function fsRowElements() {
  return [...fsTreeEl.querySelectorAll(".fs-row[data-path]")].filter((row) => {
    let el = row.parentElement
    while (el && el !== fsTreeEl) {
      if (el.hidden) return false
      el = el.parentElement
    }
    return true
  })
}

function fsSelectedPaths() {
  return fsRowElements().filter((row) => fsState.selected.has(row.dataset.path)).map((row) => row.dataset.path)
}

function applyFsSelection() {
  for (const row of fsTreeEl.querySelectorAll(".fs-row[data-path]")) {
    row.classList.toggle("selected", fsState.selected.has(row.dataset.path))
  }
}

function selectFsOnly(path) {
  fsState.selected.clear()
  fsState.selected.add(path)
  fsState.anchor = path
  applyFsSelection()
  fsTreeEl.focus?.()
}

function toggleFsSelect(path) {
  if (fsState.selected.has(path)) fsState.selected.delete(path)
  else fsState.selected.add(path)
  fsState.anchor = path
  applyFsSelection()
}

function selectFsRange(path) {
  const rows = fsRowElements()
  const paths = rows.map((row) => row.dataset.path)
  const to = paths.indexOf(path)
  if (to < 0) return
  const from = fsState.anchor != null ? paths.indexOf(fsState.anchor) : to
  const start = from < 0 ? to : Math.min(from, to)
  const end = from < 0 ? to : Math.max(from, to)
  fsState.selected.clear()
  for (let i = start; i <= end; i++) fsState.selected.add(paths[i])
  applyFsSelection()
}

function clearFsSelection() {
  fsState.selected.clear()
  fsState.anchor = null
  applyFsSelection()
}

function selectAllFsRows() {
  fsState.selected = new Set(fsRowElements().map((row) => row.dataset.path))
  applyFsSelection()
}

/** 上下键移动选择（Shift 扩展，Ctrl/Cmd 加选）。 */
function moveFsSelection(delta, extend) {
  const rows = fsRowElements()
  const paths = rows.map((row) => row.dataset.path)
  if (!paths.length) return
  let index = paths.findIndex((path) => fsState.selected.has(path))
  if (index < 0) index = delta > 0 ? -1 : paths.length
  const next = clamp(index + delta, 0, paths.length - 1)
  const path = paths[next]
  if (extend) {
    fsState.selected.add(path)
    applyFsSelection()
  } else {
    selectFsOnly(path)
  }
  rows[next]?.scrollIntoView({ block: "nearest" })
}

function renderFsTree(container, listing) {
  fsState.currentPath = listing.path
  fsState.root = listing.root
  // 换目录时重置选择（展开状态按绝对路径保留，跨刷新恢复）。
  fsState.selected.clear()
  fsState.anchor = null
  fsState.dirCache.set(listing.path, listing.entries)
  renderFsPath(listing.path, listing.root)
  // 一次性替换顶层节点（原子操作，不闪空白），随后同步从缓存恢复已展开的目录，
  // 再后台重新拉取展开目录的内容，避免「先折叠再展开」的闪烁。
  container.replaceChildren(...listing.entries.map((entry) => fsEntryNode(entry)))
  renderExpandedFromCache(container)
  applyFsSelection()
  void refreshExpandedDirs(container).then(() => applyFsSelection())
}

/** 同步从缓存恢复已展开目录（无网络等待，刷新时视觉不变）。 */
function renderExpandedFromCache(container) {
  for (const wrapper of [...container.children]) {
    if (!wrapper.classList?.contains("fs-node")) continue
    const row = wrapper.querySelector(":scope > .fs-row")
    const children = wrapper.querySelector(":scope > .fs-children")
    if (row?.dataset.type !== "dir" || !fsState.expanded.has(row.dataset.path)) continue
    children.hidden = false
    row.querySelector(".fs-caret").textContent = "▾"
    const cached = fsState.dirCache.get(row.dataset.path)
    if (cached) {
      children.replaceChildren(...cached.map((entry) => fsEntryNode(entry)))
      renderExpandedFromCache(children)
    }
  }
}

/** 后台刷新已展开目录的内容（原地替换，不改变展开状态）。 */
async function refreshExpandedDirs(container) {
  for (const wrapper of [...container.children]) {
    if (!wrapper.classList?.contains("fs-node")) continue
    const row = wrapper.querySelector(":scope > .fs-row")
    const children = wrapper.querySelector(":scope > .fs-children")
    if (row?.dataset.type !== "dir" || !fsState.expanded.has(row.dataset.path)) continue
    const entries = await fetchFsDir(row.dataset.path)
    if (entries && !children.hidden) {
      children.replaceChildren(...entries.map((entry) => fsEntryNode(entry)))
      renderExpandedFromCache(children)
    }
    await refreshExpandedDirs(children)
  }
}

async function fetchFsDir(dirPath) {
  try {
    const listing = await api(`/fs/list?path=${encodeURIComponent(dirPath)}`)
    fsState.dirCache.set(dirPath, listing.entries)
    return listing.entries
  } catch {
    return null
  }
}

function renderFsPath(dirPath, root) {
  const rel = dirPath === root ? "" : dirPath.startsWith(root) ? dirPath.slice(root.length + 1) : dirPath
  const crumbs = [{ label: root.split("/").filter(Boolean).pop() || root, path: root }]
  let acc = root
  for (const part of rel.split("/").filter(Boolean)) {
    acc = `${acc}/${part}`
    crumbs.push({ label: part, path: acc })
  }
  fsPathEl.innerHTML = crumbs
    .map((crumb, index) => `<button type="button" class="fs-crumb" data-path="${escapeHtml(crumb.path)}">${escapeHtml(crumb.label)}</button>${index < crumbs.length - 1 ? '<span class="fs-sep">/</span>' : ""}`)
    .join("")
  fsPathEl.querySelectorAll(".fs-crumb").forEach((button) => {
    button.onclick = async () => {
      fsTreeEl.innerHTML = '<div class="muted">加载中…</div>'
      try {
        renderFsTree(fsTreeEl, await api(`/fs/list?path=${encodeURIComponent(button.dataset.path)}`))
      } catch (error) {
        fsTreeEl.innerHTML = `<div class="msg error">${escapeHtml(error.message)}</div>`
      }
    }
  })
}

function fsEntryNode(entry) {
  const wrapper = document.createElement("div")
  wrapper.className = "fs-node"
  const row = document.createElement("div")
  row.className = "fs-row"
  row.dataset.path = entry.path
  row.dataset.type = entry.type
  row.draggable = true
  row.title = `${entry.path}（可拖到输入框或笔记本插入路径）`
  row.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", entry.path)
    event.dataTransfer.effectAllowed = "copy"
  })
  row.addEventListener("contextmenu", (event) => {
    if (!fsState.selected.has(entry.path)) selectFsOnly(entry.path)
    openFsMenu(event, { path: entry.path, type: entry.type })
  })
  const caret = document.createElement("span")
  caret.className = "fs-caret"
  caret.textContent = entry.type === "dir" ? "▸" : ""
  const icon = document.createElement("span")
  icon.className = "fs-icon"
  icon.textContent = entry.type === "dir" ? "📁" : "📄"
  const name = document.createElement("span")
  name.className = "fs-name"
  name.textContent = entry.name
  const meta = document.createElement("span")
  meta.className = "fs-meta"
  meta.textContent = entry.type === "dir" ? "" : formatSize(entry.size)
  row.append(caret, icon, name, meta)
  const children = document.createElement("div")
  children.className = "fs-children"
  children.hidden = true
  wrapper.append(row, children)
  row.addEventListener("click", (event) => {
    const path = entry.path
    if (event.metaKey || event.ctrlKey) { toggleFsSelect(path); return }
    if (event.shiftKey) { selectFsRange(path); return }
    selectFsOnly(path)
    if (entry.type === "dir") {
      if (fsState.expanded.has(path)) collapseFsDir(row, children, path)
      else void expandFsDir(row, children, path)
    }
  })
  // 文件：单击仅选中，双击才打开（对齐 VSCode 资源管理器）。
  if (entry.type === "file") row.addEventListener("dblclick", () => openFileViewer(entry.path))
  return wrapper
}

/** 目录展开：先用缓存即时渲染，再后台拉取刷新，避免闪烁。 */
async function expandFsDir(row, children, dirPath) {
  fsState.expanded.add(dirPath)
  children.hidden = false
  row.querySelector(".fs-caret").textContent = "▾"
  const cached = fsState.dirCache.get(dirPath)
  if (cached) children.replaceChildren(...cached.map((entry) => fsEntryNode(entry)))
  else if (!children.querySelector(".fs-node")) children.innerHTML = '<div class="muted fs-loading">加载中…</div>'
  const entries = await fetchFsDir(dirPath)
  if (entries && !children.hidden) {
    children.replaceChildren(...entries.map((entry) => fsEntryNode(entry)))
    renderExpandedFromCache(children)
  }
  applyFsSelection()
}

function collapseFsDir(row, children, dirPath) {
  children.hidden = true
  row.querySelector(".fs-caret").textContent = "▸"
  fsState.expanded.delete(dirPath)
}

// ---------------- 目录树批量操作 ----------------

function fsCopySelection() {
  const paths = fsSelectedPaths()
  if (!paths.length) return
  fsClipboard.mode = "copy"
  fsClipboard.paths = paths
  fsSetStatus(`已复制 ${paths.length} 项，请在目标目录点「粘贴」`)
}

async function fsCutSelection() {
  const paths = fsSelectedPaths()
  if (!paths.length) return
  const label = paths.length === 1 ? `「${fsBasename(paths[0])}」` : `${paths.length} 项`
  const { ok } = await confirmAction({ title: "剪切", text: `将剪切 ${label}，粘贴到目标目录后原位置移除。是否继续？`, action: "剪切" })
  if (!ok) return
  fsClipboard.mode = "cut"
  fsClipboard.paths = paths
  fsSetStatus(`已剪切 ${paths.length} 项，请在目标目录点「粘贴」`)
}

async function fsPasteInto(dir) {
  if (!fsClipboard.mode || !fsClipboard.paths.length) return
  const target = dir || fsState.currentPath
  if (!target) return
  const endpoint = fsClipboard.mode === "cut" ? "/fs/move" : "/fs/copy"
  const wasCut = fsClipboard.mode === "cut"
  let done = 0
  let renamed = null
  let failure = null
  for (const from of fsClipboard.paths) {
    try {
      const result = await fsOp(endpoint, { from, toDir: target })
      done++
      if (result?.renamed && result?.name) renamed = result.name
    } catch (error) {
      failure = error
      break
    }
  }
  if (wasCut) fsClipboard.mode = null
  await reloadFsTree()
  if (failure) fsSetStatus(`已处理 ${done} 项，粘贴失败: ${failure.message}`, true)
  else fsSetStatus((wasCut ? "已移动 " : "已粘贴 ") + done + " 项" + (renamed ? `（重名，其一改名为「${renamed}」）` : "") + (wasCut ? "（可点「撤回」还原）" : ""))
}

async function fsDeleteSelection(paths = fsSelectedPaths()) {
  if (!paths.length) return
  const label = paths.length === 1 ? `「${fsBasename(paths[0])}」` : `${paths.length} 项`
  const { ok } = await confirmAction({
    title: "永久删除",
    text: `将删除 ${label}。删除会移入回收站，可点「撤回」还原（仅能还原最近一次），是否继续？`,
    action: "删除",
  })
  if (!ok) return
  let done = 0
  let failure = null
  for (const path of paths) {
    try { await fsOp("/fs/delete", { path }); done++ }
    catch (error) { failure = error; break }
  }
  clearFsSelection()
  await reloadFsTree()
  if (failure) fsSetStatus(`已删除 ${done} 项，随后失败: ${failure.message}`, true)
  else fsSetStatus(`已删除 ${done} 项（可点「撤回」还原）`)
}

async function fsRenameSelection(path) {
  const target = path || fsSelectedPaths()[0]
  if (!target) return
  const { ok, name } = await fsPrompt({ title: "重命名", label: "新名称", value: fsBasename(target) })
  if (!ok || !name) return
  try {
    await fsOp("/fs/rename", { path: target, name })
    await reloadFsTree()
    fsSetStatus(`已重命名为：${name}（可点「撤回」还原）`)
  } catch (error) {
    fsSetStatus(`重命名失败: ${error.message}`, true)
  }
}

function fsOpenSelection() {
  const paths = fsSelectedPaths()
  const row = paths.length ? fsTreeEl.querySelector(`.fs-row[data-path="${CSS.escape(paths[0])}"]`) : null
  if (!row) return
  if (row.dataset.type === "dir") {
    const children = row.parentElement.querySelector(":scope > .fs-children")
    if (fsState.expanded.has(row.dataset.path)) collapseFsDir(row, children, row.dataset.path)
    else void expandFsDir(row, children, row.dataset.path)
  } else {
    openFileViewer(row.dataset.path)
  }
}

fsPanel.addEventListener("keydown", (event) => {
  if (fsPanel.hidden || event.isComposing) return
  if (isTextEntryTarget(event.target)) return
  const mod = event.ctrlKey || event.metaKey
  const key = event.key.toLowerCase()
  if (mod && key === "c" && !event.shiftKey) { event.preventDefault(); fsCopySelection() }
  else if (mod && key === "x" && !event.shiftKey) { event.preventDefault(); void fsCutSelection() }
  else if (mod && key === "v" && !event.shiftKey) { event.preventDefault(); void fsPasteInto(fsState.currentPath) }
  else if (mod && key === "a" && !event.shiftKey) { event.preventDefault(); selectAllFsRows() }
  else if (mod && key === "z" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); void fsUndoLast() }
  else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); void fsDeleteSelection() }
  else if (event.key === "F2") { event.preventDefault(); void fsRenameSelection() }
  else if (event.key === "Enter") { event.preventDefault(); fsOpenSelection() }
  else if (event.key === "ArrowDown") { event.preventDefault(); moveFsSelection(1, event.shiftKey) }
  else if (event.key === "ArrowUp") { event.preventDefault(); moveFsSelection(-1, event.shiftKey) }
  else if (event.key === "Escape") { clearFsSelection() }
})

fsPanel.querySelectorAll("[data-fs-mode]").forEach((button) => {
  button.onclick = () => setFsMode(button.dataset.fsMode)
})
fsPanel.querySelector("#fsClose").onclick = closeFsPanel
fsPanel.querySelector("#fsRefresh").onclick = () => void reloadFsTree()
fsPanel.querySelector("#fsMinimize").onclick = () => {
  const nextWindow = fsPanel.dataset.mode !== "window"
  fsPanel.dataset.mode = nextWindow ? "window" : "drawer"
  const button = fsPanel.querySelector("#fsMinimize")
  button.textContent = nextWindow ? "▤" : "⧉"
  button.title = nextWindow ? "停靠回侧边" : "缩小为窗口"
  if (nextWindow) {
    fsPanel.style.left = "80px"
    fsPanel.style.top = "90px"
    fsPanel.style.width = "min(420px, calc(100vw - 24px))"
    fsPanel.style.height = "min(60vh, 520px)"
  } else {
    fsPanel.style.left = ""
    fsPanel.style.top = ""
    fsPanel.style.width = ""
    fsPanel.style.height = ""
  }
  fsPanel.style.zIndex = nextWindow ? "46" : "7"
  updateMaximizedVars()
  if (tiledWindowPositions) retileContextWindows()
}
fsPanel.querySelector("#fsBindDir").onclick = async () => {
  if (!fsState.currentPath) {
    fsSetStatus("请先在「全局」中打开一个目录", true)
    return
  }
  const dir = fsState.currentPath
  await fsSetWorkspaceDir(dir)
  if (fsActiveWorkspace()?.dir === dir) setFsMode("workspace")
}
const fsDirInput = fsPanel.querySelector("#fsDirInput")
fsPanel.querySelector("#fsSetDir").onclick = () => void fsSetWorkspaceDir(fsDirInput.value)
fsDirInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return
  event.preventDefault()
  void fsSetWorkspaceDir(fsDirInput.value)
})
fsPanel.querySelector("#fsClearDir").onclick = () => void fsSetWorkspaceDir("")

attachWindowResize(fsPanel, {
  minWidth: 300,
  minHeight: 220,
  save: (w, h) => localStorage.setItem("nodex.fsSize", JSON.stringify({ w, h })),
})

// 窗口模式下拖动标题栏
fsPanel.querySelector(".fs-head").addEventListener("pointerdown", (event) => {
  if (event.target.closest("button")) return
  if (fsPanel.dataset.mode !== "window") return
  event.preventDefault()
  const head = event.currentTarget
  const rect = fsPanel.getBoundingClientRect()
  const dx = event.clientX - rect.left
  const dy = event.clientY - rect.top
  head.style.cursor = "grabbing"
  head.setPointerCapture(event.pointerId)
  const move = (e) => {
    fsPanel.style.left = clamp(e.clientX - dx, 0, window.innerWidth - 60) + "px"
    fsPanel.style.top = clamp(e.clientY - dy, 0, window.innerHeight - 40) + "px"
  }
  const stop = () => {
    head.style.cursor = ""
    head.removeEventListener("pointermove", move)
    head.removeEventListener("pointercancel", stop)
  }
  head.addEventListener("pointermove", move)
  head.addEventListener("pointerup", stop, { once: true })
  head.addEventListener("pointercancel", stop, { once: true })
})

// ---------------- 笔记本 ----------------
async function createNotebook(name = "未命名笔记本", position = null) {
  const nb = await api("/nodes", {
    method: "POST",
    body: JSON.stringify({ kind: "notebook", title: name, workspaceId: state.activeWs || undefined }),
  })
  if (position) {
    state.positions.set(nb.id, { ...position })
    state.anchors.set(nb.id, { ...position })
    state.pinned.add(nb.id)
    savedPositions.set(nb.id, { ...position })
    savePinnedPositions()
  }
  await refresh()
  select({ type: "node", id: nb.id })
  await openNodePanel(nb.id)
  statusEl.textContent = "已新建笔记本，可直接打草稿或从对话中摘录"
  return nb
}

/** 打开（或聚焦）一个笔记本窗口；每个笔记本拥有独立浮窗，可同时打开多个。 */
async function openNotebookViewer(nodeId) {
  let viewer = notebookWindows.get(nodeId)
  if (viewer) {
    focusContextViewer(viewer)
    showWindow(viewer)
    return viewer
  }
  viewer = notebookTemplate.content.firstElementChild.cloneNode(true)
  viewer.dataset.nodeId = nodeId
  viewer.summaryCollapsed = loadSummaryCollapsed()[nodeId] === true
  const { w, h } = notebookWindowSize()
  viewer.style.width = w + "px"
  viewer.style.height = h + "px"
  document.getElementById("app").append(viewer)
  notebookWindows.set(nodeId, viewer)
  renderNotebookBody(viewer)
  attachNotebookWindow(viewer)
  applyTitleButtonConfig(viewer)
  const node = state.nodesById.get(nodeId)
  renderNotebookTitle(viewer, node)
  renderNotebookSummary(viewer, node)
  renderPageBadges(viewer.querySelector(".context-viewer-pages"), nodeId)
  viewer.classList.add("open")
  focusContextViewer(viewer)
  positionContextViewer(viewer, nodeId)
  if (viewer.editing) viewer.querySelector(".nb-doc").focus()
  if (tiledWindowPositions) {
    tiledWindowPositions.set(viewer, {
      style: { left: viewer.style.left, top: viewer.style.top, width: viewer.style.width, height: viewer.style.height, zIndex: "" },
      maximized: false,
    })
    retileContextWindows()
  }
  updatePinButtons()
  updateTilingButtons()
  updatePersistButtons()
  saveWindowSessionSoon()
  scheduleDraw()
  return viewer
}

function renderNotebookTitle(viewer, node) {
  const titleEl = viewer.querySelector(".notebook-viewer-title")
  if (!titleEl || titleEl.isContentEditable) return
  titleEl.textContent = node ? nodeDisplayTitle(node.id) : "草稿本"
}

function renderNotebookSummary(viewer, node, showEmpty = false) {
  const box = viewer.querySelector(".nb-summary")
  const body = viewer.querySelector(".nb-summary-body")
  if (viewer.summaryCollapsed && !showEmpty) { box.hidden = true; return }
  const latest = node?.summaries?.at(-1)
  if (latest?.text) {
    body.innerHTML = renderMarkdown(latest.text)
    box.hidden = false
    viewer.summaryCollapsed = false
    setSummaryCollapsed(node?.id, false)
  } else if (showEmpty) {
    body.innerHTML = '<span class="muted">未能生成摘要</span>'
    box.hidden = false
  } else {
    box.hidden = true
  }
}

// 摘要收起状态按节点记忆：关闭笔记本再打开时保持上次的收起 / 展开状态。
const SUMMARY_COLLAPSED_KEY = "nodex.summaryCollapsed"

function loadSummaryCollapsed() {
  try { return JSON.parse(localStorage.getItem(SUMMARY_COLLAPSED_KEY) || "{}") } catch { return {} }
}

function setSummaryCollapsed(nodeId, collapsed) {
  if (!nodeId) return
  try {
    const map = loadSummaryCollapsed()
    if (collapsed) map[nodeId] = true
    else delete map[nodeId]
    localStorage.setItem(SUMMARY_COLLAPSED_KEY, JSON.stringify(map))
  } catch { /* Ignore blocked storage. */ }
}

// ---------------- 笔记本编辑：历史 / 列表 / 缩进 / 搜索 / 选区菜单 ----------------
const NB_HISTORY_LIMIT = 300

function nbSnapshot(docEl) {
  return { value: docEl.value, start: docEl.selectionStart, end: docEl.selectionEnd }
}

function nbResetHistory(viewer, docEl) {
  viewer.nbHistory = { stack: [nbSnapshot(docEl)], index: 0, timer: null }
  nbUpdateHistoryButtons(viewer)
}

function nbRecord(viewer, docEl) {
  const h = viewer.nbHistory
  if (!h) return
  const snap = nbSnapshot(docEl)
  const current = h.stack[h.index]
  if (current && current.value === snap.value) return
  h.stack = h.stack.slice(0, h.index + 1)
  h.stack.push(snap)
  if (h.stack.length > NB_HISTORY_LIMIT) h.stack.shift()
  h.index = h.stack.length - 1
  nbUpdateHistoryButtons(viewer)
}

function nbFlushHistory(viewer, docEl) {
  const h = viewer.nbHistory
  if (!h) return
  clearTimeout(h.timer)
  h.timer = null
  nbRecord(viewer, docEl)
}

function nbScheduleHistory(viewer, docEl) {
  const h = viewer.nbHistory
  if (!h) return
  clearTimeout(h.timer)
  h.timer = setTimeout(() => { h.timer = null; nbRecord(viewer, docEl) }, 400)
}

function nbUpdateHistoryButtons(viewer) {
  const h = viewer.nbHistory
  const docEl = viewer.querySelector(".nb-doc")
  const undoBtn = viewer.querySelector(".nb-undo")
  const redoBtn = viewer.querySelector(".nb-redo")
  const dirty = Boolean(h && docEl && h.stack[h.index] && h.stack[h.index].value !== docEl.value)
  if (undoBtn) undoBtn.disabled = !h || (h.index <= 0 && !dirty)
  if (redoBtn) redoBtn.disabled = !h || h.index >= h.stack.length - 1
}

function nbApplySnapshot(viewer, docEl, snap) {
  viewer.nbApplying = true
  docEl.value = snap.value
  docEl.focus()
  const start = Math.min(snap.start, snap.value.length)
  const end = Math.min(snap.end, snap.value.length)
  docEl.setSelectionRange(start, end)
  docEl.dispatchEvent(new Event("input", { bubbles: true }))
  viewer.nbApplying = false
  nbUpdateHistoryButtons(viewer)
}

function nbUndo(viewer) {
  const docEl = viewer.querySelector(".nb-doc")
  const h = viewer.nbHistory
  if (!h || !docEl) return
  nbFlushHistory(viewer, docEl)
  if (h.index <= 0) { statusEl.textContent = "没有可撤回的编辑"; return }
  h.index -= 1
  nbApplySnapshot(viewer, docEl, h.stack[h.index])
  statusEl.textContent = "已撤回上一步编辑"
}

function nbRedo(viewer) {
  const docEl = viewer.querySelector(".nb-doc")
  const h = viewer.nbHistory
  if (!h || !docEl) return
  nbFlushHistory(viewer, docEl)
  if (h.index >= h.stack.length - 1) { statusEl.textContent = "没有可重做的编辑"; return }
  h.index += 1
  nbApplySnapshot(viewer, docEl, h.stack[h.index])
  statusEl.textContent = "已重做上一步编辑"
}

/** 程序化编辑：先记录编辑前状态，应用后立即记录结果，保证可撤回。 */
function nbMutate(viewer, docEl, mutate) {
  nbFlushHistory(viewer, docEl)
  mutate()
  docEl.focus()
  docEl.dispatchEvent(new Event("input", { bubbles: true }))
  nbFlushHistory(viewer, docEl)
}

function nbPrefix(kind) {
  return kind === "heading" ? "# " : kind === "heading2" ? "## " : kind === "bullet" ? "- "
    : kind === "ordered" ? "1. " : kind === "check" ? "- [ ] " : kind === "quote" ? "> " : ""
}

function nbLineHasMarker(line, kind) {
  const t = line.replace(/^\s*/, "")
  if (kind === "heading") return /^#{1}\s/.test(t)
  if (kind === "heading2") return /^#{2}\s/.test(t)
  if (kind === "bullet") return /^[-*+]\s/.test(t) && !/^[-*+]\s\[[ xX]\]/.test(t)
  if (kind === "ordered") return /^\d+[.)]\s/.test(t)
  if (kind === "check") return /^[-*+]\s\[[ xX]\]\s/.test(t)
  if (kind === "quote") return /^>\s?/.test(t)
  return false
}

/** 对选中行块套用 / 取消行级 Markdown 标记；有序列表按行续号。 */
function nbApplyLineMarkers(kind, block) {
  const lines = block.split("\n")
  const allHave = lines.every((line) => !line.trim() || nbLineHasMarker(line, kind))
  let counter = 0
  return lines.map((line) => {
    if (!line.trim()) return line
    const indent = line.match(/^\s*/)[0]
    let text = line.slice(indent.length)
    if (allHave) {
      return indent + text
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*+]\s\[[ xX]\]\s/, "")
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .replace(/^>\s?/, "")
    }
    text = text
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s\[[ xX]\]\s/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^>\s?/, "")
    if (kind === "ordered") { counter += 1; return `${indent}${counter}. ${text}` }
    if (kind === "check") { counter += 1; return `${indent}- [ ] ${text}` }
    return `${indent}${nbPrefix(kind)}${text}`
  }).join("\n")
}

/** Tab / Shift+Tab：对选中行整体缩进或反缩进（两个空格）。 */
function nbIndent(docEl, outdent) {
  const value = docEl.value
  const start = docEl.selectionStart
  const end = docEl.selectionEnd
  const blockStart = value.lastIndexOf("\n", start - 1) + 1
  let blockEnd = value.indexOf("\n", end)
  if (blockEnd < 0) blockEnd = value.length
  const lines = value.slice(blockStart, blockEnd).split("\n")
  let deltaStart = 0
  let deltaEnd = 0
  const next = lines.map((line, index) => {
    if (outdent) {
      const removed = line.match(/^(\t| {1,2})/)
      const cut = removed ? removed[1].length : 0
      if (index === 0) deltaStart = -cut
      deltaEnd -= cut
      return line.slice(cut)
    }
    if (index === 0) deltaStart = 2
    deltaEnd += 2
    return "  " + line
  }).join("\n")
  docEl.value = value.slice(0, blockStart) + next + value.slice(blockEnd)
  docEl.setSelectionRange(Math.max(blockStart, start + deltaStart), Math.max(blockStart, end + deltaEnd))
}

/** 回车时延续当前列表 / 引用格式；空条目则退出列表。返回是否已处理。 */
function nbContinueLine(docEl) {
  const start = docEl.selectionStart
  if (start !== docEl.selectionEnd) return false
  const value = docEl.value
  const lineStart = value.lastIndexOf("\n", start - 1) + 1
  const lineEndIdx = value.indexOf("\n", start)
  const lineEnd = lineEndIdx < 0 ? value.length : lineEndIdx
  const line = value.slice(lineStart, lineEnd)
  const list = line.match(/^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/)
  const quote = line.match(/^(\s*)(>+)\s?(.*)$/)
  if (!list && !quote) return false
  if (list) {
    const [, indent, bullet, num, delim, gap, task, rest] = list
    if (!rest.trim()) {
      docEl.value = value.slice(0, lineStart) + indent + value.slice(lineEnd)
      const pos = lineStart + indent.length
      docEl.setSelectionRange(pos, pos)
      docEl.dispatchEvent(new Event("input", { bubbles: true }))
      return true
    }
    const marker = bullet ? bullet + " " : String(Number(num) + 1) + delim + " "
    const insert = "\n" + indent + marker + (task ? "[ ] " : "")
    docEl.value = value.slice(0, start) + insert + value.slice(start)
    const pos = start + insert.length
    docEl.setSelectionRange(pos, pos)
    docEl.dispatchEvent(new Event("input", { bubbles: true }))
    return true
  }
  const [, indent, marks, rest] = quote
  if (!rest.trim()) {
    docEl.value = value.slice(0, lineStart) + indent + value.slice(lineEnd)
    const pos = lineStart + indent.length
    docEl.setSelectionRange(pos, pos)
    docEl.dispatchEvent(new Event("input", { bubbles: true }))
    return true
  }
  const insert = "\n" + indent + marks + " "
  docEl.value = value.slice(0, start) + insert + value.slice(start)
  const pos = start + insert.length
  docEl.setSelectionRange(pos, pos)
  docEl.dispatchEvent(new Event("input", { bubbles: true }))
  return true
}

function closeNotebookSearch(viewer) {
  const bar = viewer.querySelector(".nb-search")
  if (!bar || bar.hidden) return
  bar.hidden = true
  bar.querySelector(".nb-search-input").value = ""
  bar.querySelector(".nb-search-count").textContent = ""
  viewer.nbSearch = null
}

function openNotebookSearch(viewer) {
  const bar = viewer.querySelector(".nb-search")
  if (!bar) return
  if (!viewer.editing) viewer.setNotebookEditing?.(true)
  bar.hidden = false
  const input = bar.querySelector(".nb-search-input")
  input.focus()
  input.select()
}

function nbSearchRun(viewer, direction, focusEditor) {
  const docEl = viewer.querySelector(".nb-doc")
  const input = viewer.querySelector(".nb-search-input")
  const countEl = viewer.querySelector(".nb-search-count")
  if (!docEl || !input) return
  const query = input.value
  if (!query) { countEl.textContent = ""; viewer.nbSearch = null; return }
  const hay = docEl.value.toLowerCase()
  const needle = query.toLowerCase()
  const matches = []
  let at = hay.indexOf(needle)
  while (at !== -1) { matches.push(at); at = hay.indexOf(needle, at + needle.length) }
  if (!matches.length) { countEl.textContent = "0/0"; viewer.nbSearch = null; return }
  let index = viewer.nbSearch?.query === query ? viewer.nbSearch.index : -1
  index = (index + (direction ?? 1) + matches.length) % matches.length
  viewer.nbSearch = { query, index, matches }
  countEl.textContent = `${index + 1}/${matches.length}`
  const start = matches[index]
  docEl.setSelectionRange(start, start + needle.length)
  if (focusEditor) docEl.focus()
}

function hideNotebookSelMenu(viewer) {
  const menu = viewer.querySelector(".nb-sel-menu")
  if (!menu || menu.hidden) return
  menu.hidden = true
  menu.replaceChildren()
  viewer.nbSuppressBlur = false
}

const NB_REWRITE_SHORTCUTS_KEY = "nodex.nbRewriteShortcuts"

function loadNbRewriteShortcuts() {
  try {
    const list = JSON.parse(localStorage.getItem(NB_REWRITE_SHORTCUTS_KEY) || "[]")
    return Array.isArray(list) ? list.filter((item) => item && item.name && item.instruction) : []
  } catch { return [] }
}

function saveNbRewriteShortcuts(list) {
  try { localStorage.setItem(NB_REWRITE_SHORTCUTS_KEY, JSON.stringify(list)) } catch { /* Ignore blocked storage. */ }
}

const NB_QUICK_INSTRUCTIONS = {
  "摘要": "总结这段内容，提炼要点",
  "翻译成中文": "翻译成中文",
  "翻译成英文": "翻译成英文",
}

function showNotebookSelMenu(viewer, point) {
  const docEl = viewer.querySelector(".nb-doc")
  const menu = viewer.querySelector(".nb-sel-menu")
  if (!docEl || !menu) return
  const start = docEl.selectionStart
  const end = docEl.selectionEnd
  if (start === end || !docEl.value.slice(start, end).trim()) { hideNotebookSelMenu(viewer); return }
  viewer.nbSelRange = { start, end }
  const shortcuts = loadNbRewriteShortcuts()
  menu.hidden = false
  menu.innerHTML = `
    <div class="nb-sel-actions">
      <button type="button" data-nb-sel="copy">复制</button>
      <button type="button" data-nb-sel="cut">剪切</button>
      <button type="button" data-nb-quick="摘要">摘要</button>
      <button type="button" data-nb-quick="翻译成中文">翻译成中文</button>
      <button type="button" data-nb-quick="翻译成英文">翻译成英文</button>
      ${shortcuts.map((item, index) => `<button type="button" data-nb-custom="${index}" title="${escapeHtml(item.instruction)}">${escapeHtml(item.name)}</button>`).join("")}
      <button type="button" data-nb-add-shortcut title="添加改写快捷键">＋</button>
    </div>
    <div class="nb-sel-rewrite">
      <textarea class="nb-rewrite-input" rows="1" placeholder="AI 改写指令，如：更简洁 / 翻译成英文"></textarea>
      <button type="button" data-nb-sel="node">对话</button>
      <button type="button" class="nb-rewrite-go primary">改写</button>
    </div>
  `
  const rect = viewer.getBoundingClientRect()
  const x = point ? point.x - rect.left : 12
  const y = point ? point.y - rect.top + 8 : 12
  const maxX = Math.max(8, viewer.clientWidth - menu.offsetWidth - 8)
  const maxY = Math.max(8, viewer.clientHeight - menu.offsetHeight - 8)
  menu.style.left = clamp(x, 8, maxX) + "px"
  menu.style.top = clamp(y, 8, maxY) + "px"
  menu.querySelector('[data-nb-sel="copy"]').onclick = async () => {
    const text = docEl.value.slice(viewer.nbSelRange.start, viewer.nbSelRange.end)
    try {
      await navigator.clipboard.writeText(text)
      statusEl.textContent = "已复制选中文本"
    } catch {
      statusEl.textContent = "复制失败，请手动复制"
    }
    hideNotebookSelMenu(viewer)
  }
  menu.querySelector('[data-nb-sel="cut"]').onclick = async () => {
    const { start: s, end: e } = viewer.nbSelRange
    const text = docEl.value.slice(s, e)
    try { await navigator.clipboard.writeText(text) } catch { /* 剪贴板不可用时仍执行剪切 */ }
    nbMutate(viewer, docEl, () => {
      docEl.value = docEl.value.slice(0, s) + docEl.value.slice(e)
      docEl.setSelectionRange(s, s)
    })
    hideNotebookSelMenu(viewer)
    statusEl.textContent = "已剪切选中文本"
  }
  menu.querySelector('[data-nb-sel="node"]').onclick = async () => {
    const { start: s, end: e } = viewer.nbSelRange
    const text = docEl.value.slice(s, e)
    hideNotebookSelMenu(viewer)
    if (!text.trim()) return
    try {
      const title = `摘录：${text.slice(0, 12).replace(/\n/g, " ")}`
      const node = await api("/nodes", {
        method: "POST",
        body: JSON.stringify({
          title,
          seed: `【摘录自「${state.nodesById.get(viewer.dataset.nodeId)?.title ?? "笔记本"}」】\n\n${text}\n\n（以上为背景资料，请在此基础上继续。）`,
          workspaceId: state.activeWs || undefined,
          model: currentModel(),
        }),
      })
      await refresh()
      select({ type: "node", id: node.id })
      statusEl.textContent = `已用选中文本新建对话节点「${title}」`
    } catch (error) {
      statusEl.textContent = "新建失败: " + error.message
    }
  }
  const rewriteInput = menu.querySelector(".nb-rewrite-input")
  const run = () => { void runNotebookRewrite(viewer, rewriteInput.value.trim()) }
  menu.querySelector(".nb-rewrite-go").onclick = run
  const runInstruction = (instruction) => {
    rewriteInput.value = instruction
    autoGrow()
    void runNotebookRewrite(viewer, instruction)
  }
  menu.querySelectorAll("[data-nb-quick]").forEach((button) => {
    button.onclick = () => runInstruction(NB_QUICK_INSTRUCTIONS[button.dataset.nbQuick] || button.dataset.nbQuick)
  })
  menu.querySelectorAll("[data-nb-custom]").forEach((button) => {
    button.onclick = () => {
      const item = loadNbRewriteShortcuts()[Number(button.dataset.nbCustom)]
      if (item) runInstruction(item.instruction)
    }
  })
  menu.querySelector("[data-nb-add-shortcut]").onclick = async () => {
    const nameResult = await fsPrompt({ title: "添加快捷键", label: "按钮名称", value: "" })
    if (!nameResult.ok || !nameResult.name) return
    const insResult = await fsPrompt({ title: "添加快捷键", label: "改写指令", value: "" })
    if (!insResult.ok || !insResult.name) return
    const list = loadNbRewriteShortcuts()
    list.push({ name: nameResult.name, instruction: insResult.name })
    saveNbRewriteShortcuts(list)
    showNotebookSelMenu(viewer, viewer.nbSelPoint)
  }
  rewriteInput.addEventListener("mousedown", (event) => event.stopPropagation())
  const autoGrow = () => {
    rewriteInput.style.height = "auto"
    rewriteInput.style.height = Math.min(rewriteInput.scrollHeight, 72) + "px"
  }
  rewriteInput.addEventListener("input", autoGrow)
  rewriteInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); run() }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hideNotebookSelMenu(viewer); docEl.focus() }
  })
}

async function runNotebookRewrite(viewer, instruction) {
  const docEl = viewer.querySelector(".nb-doc")
  const range = viewer.nbSelRange
  if (!docEl || !range) return
  const text = docEl.value.slice(range.start, range.end)
  if (!text.trim()) return
  const menu = viewer.querySelector(".nb-sel-menu")
  const go = menu.querySelector(".nb-rewrite-go")
  if (go) { go.disabled = true; go.textContent = "改写中…" }
  try {
    const result = await api(`/nodes/${viewer.dataset.nodeId}/notebook-rewrite`, {
      method: "POST",
      body: JSON.stringify({ text, instruction: instruction || "在保持原意的前提下润色，使表达更清晰" }),
      timeout: 120000,
    })
    const next = typeof result.text === "string" ? result.text : ""
    if (!next) throw new Error("模型未返回内容")
    nbMutate(viewer, docEl, () => {
      docEl.value = docEl.value.slice(0, range.start) + next + docEl.value.slice(range.end)
      docEl.setSelectionRange(range.start, range.start + next.length)
    })
    hideNotebookSelMenu(viewer)
    docEl.focus()
    statusEl.textContent = "已用 AI 改写选中文本"
  } catch (error) {
    if (go) { go.disabled = false; go.textContent = "改写" }
    statusEl.textContent = "AI 改写失败: " + error.message
  }
}

document.addEventListener("mousedown", (event) => {
  for (const viewer of notebookWindows.values()) {
    const menu = viewer.querySelector(".nb-sel-menu")
    if (menu && !menu.hidden && !menu.contains(event.target)) hideNotebookSelMenu(viewer)
  }
  for (const viewer of fileWindows.values()) {
    const menu = viewer.querySelector(".file-sel-menu")
    if (menu && !menu.hidden && !menu.contains(event.target)) hideFileSelMenu(viewer)
  }
})

/** 笔记本窗口内容：默认预览，点击进入编辑并显示 Markdown 工具栏，自动保存。 */
function renderNotebookBody(viewer) {
  const docEl = viewer.querySelector(".nb-doc")
  const previewEl = viewer.querySelector(".nb-preview")
  const editorEl = viewer.querySelector(".nb-editor")
  const node = state.nodesById.get(viewer.dataset.nodeId)
  docEl.value = node?.meta?.doc ?? ""
  viewer.savedDoc = docEl.value
  viewer.pendingSave = Promise.resolve()
  viewer.saveTimer = null
  viewer.nbSuppressBlur = false
  nbResetHistory(viewer, docEl)

  const flushDoc = () => {
    clearTimeout(viewer.saveTimer)
    const doc = docEl.value
    viewer.pendingSave = viewer.pendingSave.catch(() => {}).then(async () => {
      if (doc === viewer.savedDoc) return
      try {
        await api(`/nodes/${viewer.dataset.nodeId}/doc`, {
          method: "PUT",
          body: JSON.stringify({ doc }),
        })
        viewer.savedDoc = doc
        const saved = state.nodesById.get(viewer.dataset.nodeId)
        if (saved) saved.meta = { ...saved.meta, doc }
      } catch (error) {
        statusEl.textContent = "草稿保存失败: " + error.message
        throw error
      }
    })
    return viewer.pendingSave
  }
  viewer.flushNotebook = flushDoc

  const setEditing = (editing) => {
    viewer.editing = editing
    editorEl.hidden = !editing
    previewEl.hidden = editing
    const modeBtn = viewer.querySelector(".notebook-viewer-mode")
    if (modeBtn) modeBtn.textContent = editing ? "预览" : "编辑"
    if (editing) {
      docEl.focus()
    } else {
      hideNotebookSelMenu(viewer)
      closeNotebookSearch(viewer)
      renderNotebookPreview(previewEl, docEl.value)
    }
  }
  viewer.setNotebookEditing = setEditing

  previewEl.onclick = () => setEditing(true)

  const editMarkdown = (kind) => {
    if (["heading", "heading2", "bullet", "ordered", "check", "quote"].includes(kind)) {
      nbMutate(viewer, docEl, () => {
        const value = docEl.value
        const start = docEl.selectionStart
        const end = docEl.selectionEnd
        const blockStart = value.lastIndexOf("\n", start - 1) + 1
        let blockEnd = value.indexOf("\n", end)
        if (blockEnd < 0) blockEnd = value.length
        const nextBlock = nbApplyLineMarkers(kind, value.slice(blockStart, blockEnd))
        docEl.value = value.slice(0, blockStart) + nextBlock + value.slice(blockEnd)
        docEl.setSelectionRange(blockStart, blockStart + nextBlock.length)
      })
      return
    }
    if (kind === "hr") {
      nbMutate(viewer, docEl, () => {
        const value = docEl.value
        const start = docEl.selectionStart
        const end = docEl.selectionEnd
        const lineStart = value.lastIndexOf("\n", start - 1) + 1
        let lineEnd = value.indexOf("\n", end)
        if (lineEnd < 0) lineEnd = value.length
        docEl.value = value.slice(0, lineStart) + "---" + value.slice(lineEnd)
        docEl.setSelectionRange(lineStart, lineStart + 3)
      })
      return
    }
    const pairs = {
      bold: ["**", "**", "粗体"],
      italic: ["*", "*", "斜体"],
      strike: ["~~", "~~", "删除线"],
      code: ["`", "`", "代码"],
      codeblock: ["```\n", "\n```", "代码"],
      link: ["[", "](https://)", "链接"],
    }
    const [before, after, fallback] = pairs[kind] ?? ["", "", ""]
    nbMutate(viewer, docEl, () => {
      const start = docEl.selectionStart
      const end = docEl.selectionEnd
      const selected = docEl.value.slice(start, end)
      const replacement = selected || fallback
      docEl.value = docEl.value.slice(0, start) + before + replacement + after + docEl.value.slice(end)
      docEl.setSelectionRange(start + before.length, start + before.length + replacement.length)
    })
  }

  viewer.querySelectorAll("[data-md]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault())
    button.onclick = () => editMarkdown(button.dataset.md)
    button.addEventListener("mouseenter", () => showMdTooltip(button))
    button.addEventListener("mouseleave", hideMdTooltip)
    button.addEventListener("focus", () => showMdTooltip(button))
    button.addEventListener("blur", hideMdTooltip)
  })
  const undoBtn = viewer.querySelector(".nb-undo")
  const redoBtn = viewer.querySelector(".nb-redo")
  if (undoBtn) { undoBtn.addEventListener("mousedown", (event) => event.preventDefault()); undoBtn.onclick = () => nbUndo(viewer) }
  if (redoBtn) { redoBtn.addEventListener("mousedown", (event) => event.preventDefault()); redoBtn.onclick = () => nbRedo(viewer) }

  const searchBar = viewer.querySelector(".nb-search")
  const searchInput = searchBar.querySelector(".nb-search-input")
  searchInput.addEventListener("input", () => { viewer.nbSearch = null; nbSearchRun(viewer, 1, false) })
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); nbSearchRun(viewer, event.shiftKey ? -1 : 1, true) }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeNotebookSearch(viewer); docEl.focus() }
  })
  searchBar.querySelector(".nb-search-prev").onclick = () => nbSearchRun(viewer, -1, true)
  searchBar.querySelector(".nb-search-next").onclick = () => nbSearchRun(viewer, 1, true)
  searchBar.querySelector(".nb-search-close").onclick = () => { closeNotebookSearch(viewer); docEl.focus() }

  docEl.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      if (!searchBar.hidden) { closeNotebookSearch(viewer); return }
      if (!viewer.querySelector(".nb-sel-menu").hidden) { hideNotebookSelMenu(viewer); return }
      setEditing(false)
      return
    }
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      nbMutate(viewer, docEl, () => nbIndent(docEl, event.shiftKey))
      return
    }
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (nbContinueLine(docEl)) { event.preventDefault(); event.stopPropagation(); nbFlushHistory(viewer, docEl); return }
    }
    if (!(event.metaKey || event.ctrlKey)) return
    const key = event.key.toLowerCase()
    if (key === "z" && !event.altKey) {
      event.preventDefault(); event.stopPropagation()
      if (event.shiftKey) nbRedo(viewer); else nbUndo(viewer)
      return
    }
    if (key === "y" && !event.altKey) { event.preventDefault(); event.stopPropagation(); nbRedo(viewer); return }
    if (key === "f" && !event.altKey && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); openNotebookSearch(viewer); return }
    const kind = event.altKey && key === "1" ? "heading" : event.altKey && key === "2" ? "heading2" : key === "b" ? "bold" : key === "i" ? "italic" : key === "k" ? "link" : null
    if (!kind) return
    event.preventDefault()
    event.stopPropagation()
    editMarkdown(kind)
  })

  docEl.addEventListener("input", () => {
    clearTimeout(viewer.saveTimer)
    viewer.saveTimer = setTimeout(() => flushDoc().catch(() => {}), 800)
    if (!viewer.nbApplying) nbScheduleHistory(viewer, docEl)
    nbUpdateHistoryButtons(viewer)
  })
  docEl.addEventListener("blur", (event) => {
    clearTimeout(viewer.saveTimer)
    flushDoc().catch(() => {})
    const next = event.relatedTarget
    const staying = next instanceof Element && viewer.contains(next) && Boolean(next.closest(".nb-search, .nb-sel-menu"))
    if (viewer.editing && !viewer.nbSuppressBlur && !staying && viewer.querySelector(".nb-sel-menu").hidden) setEditing(false)
  })
  docEl.addEventListener("mouseup", (event) => {
    viewer.nbSelPoint = { x: event.clientX, y: event.clientY }
    showNotebookSelMenu(viewer, viewer.nbSelPoint)
  })
  docEl.addEventListener("keyup", (event) => {
    if (event.shiftKey || event.key.startsWith("Arrow") || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a")) {
      showNotebookSelMenu(viewer, null)
    }
  })
  docEl.addEventListener("scroll", () => hideNotebookSelMenu(viewer))

  setEditing(!docEl.value.trim())
}

/** 服务端追加内容（如摘录）后，把最新草稿同步回已打开的窗口。 */
function reloadNotebookDoc(viewer) {
  const node = state.nodesById.get(viewer.dataset.nodeId)
  const docEl = viewer.querySelector(".nb-doc")
  docEl.value = node?.meta?.doc ?? ""
  viewer.savedDoc = docEl.value
  nbResetHistory(viewer, docEl)
  if (!viewer.editing) {
    const previewEl = viewer.querySelector(".nb-preview")
    renderNotebookPreview(previewEl, docEl.value)
  }
}

/** 标题内联改名：Enter 提交、Esc 取消；restore 用于放弃或失败时回退显示。 */
function startTitleRename(titleEl, nodeId, fallback, restore) {
  if (!titleEl || titleEl.isContentEditable) return
  const original = state.nodesById.get(nodeId)?.title || fallback
  titleEl.contentEditable = "true"
  titleEl.focus()
  const range = document.createRange()
  range.selectNodeContents(titleEl)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  const finish = async (commit) => {
    if (!titleEl.isContentEditable) return
    titleEl.contentEditable = "false"
    titleEl.onblur = null
    titleEl.onkeydown = null
    const value = titleEl.textContent.trim()
    if (!commit || !value || value === original) {
      restore()
      return
    }
    titleEl.textContent = value
    try {
      await api(`/nodes/${nodeId}`, { method: "PATCH", body: JSON.stringify({ title: value }) })
      const node = state.nodesById.get(nodeId)
      if (node) node.title = value
      await refresh()
    } catch (error) {
      titleEl.textContent = original
      statusEl.textContent = "改名失败: " + error.message
    }
  }
  titleEl.onblur = () => finish(true)
  titleEl.onkeydown = (event) => {
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); finish(true) }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(false) }
  }
}

function startNotebookRename(viewer) {
  const nodeId = viewer.dataset.nodeId
  startTitleRename(viewer.querySelector(".notebook-viewer-title"), nodeId, "草稿本", () => renderNotebookTitle(viewer, state.nodesById.get(nodeId)))
}

function notebookHasAiSummary(node) {
  return (node?.summaries ?? []).some((item) => item.source === "ai")
}

function closeNotebookAiMenu(viewer) {
  const menu = viewer.querySelector(".nb-ai-menu")
  if (menu) { menu.hidden = true; menu.replaceChildren() }
}

function showNotebookSummary(viewer) {
  viewer.summaryCollapsed = false
  renderNotebookSummary(viewer, state.nodesById.get(viewer.dataset.nodeId), true)
}

/** 已有 AI 摘要时先让用户选择「显示已有」还是「重新生成」。 */
function generateNotebookSummary(viewer) {
  const node = state.nodesById.get(viewer.dataset.nodeId)
  if (!notebookHasAiSummary(node)) {
    closeNotebookAiMenu(viewer)
    return runNotebookSummary(viewer)
  }
  const menu = viewer.querySelector(".nb-ai-menu")
  if (!menu.hidden) { closeNotebookAiMenu(viewer); return }
  menu.innerHTML = `<button type="button" data-nb-ai="show">显示已有摘要</button><button type="button" data-nb-ai="regen">重新生成摘要</button>`
  menu.hidden = false
  menu.querySelector('[data-nb-ai="show"]').onclick = () => { closeNotebookAiMenu(viewer); showNotebookSummary(viewer) }
  menu.querySelector('[data-nb-ai="regen"]').onclick = () => { closeNotebookAiMenu(viewer); void runNotebookSummary(viewer) }
}

async function runNotebookSummary(viewer) {
  const nodeId = viewer.dataset.nodeId
  const button = viewer.querySelector(".notebook-viewer-ai")
  if (button.disabled) return
  button.disabled = true
  const previous = button.textContent
  button.textContent = "生成中…"
  setViewerAiRunning(viewer, true)
  try {
    await viewer.flushNotebook?.()
    await api(`/nodes/${nodeId}/notebook-summary`, { method: "POST", body: "{}", timeout: 120000 })
    await refresh()
    const node = state.nodesById.get(nodeId)
    renderNotebookTitle(viewer, node)
    renderNotebookSummary(viewer, node, true)
  } catch (error) {
    statusEl.textContent = "摘要生成失败: " + error.message
  } finally {
    button.disabled = false
    button.textContent = previous
    setViewerAiRunning(viewer, false)
  }
}

function closeNotebookViewer(viewer) {
  notebookWindows.delete(viewer.dataset.nodeId)
  tiledWindowPositions?.delete(viewer)
  tileOrder = tileOrder.filter((item) => item !== viewer)
  viewer.flushNotebook?.().catch(() => {})
  closeNotebookAiMenu(viewer)
  hideMdTooltip()
  viewer.remove()
  updatePinButtons()
  updateTilingButtons()
  if (tiledWindowPositions) retileContextWindows()
  saveWindowSessionSoon()
  scheduleDraw()
}

const mdTooltip = document.getElementById("mdTooltip")
function hideMdTooltip() { mdTooltip.classList.remove("open") }
function showMdTooltip(button) {
  mdTooltip.textContent = button.dataset.tip
  mdTooltip.classList.add("open")
  const rect = button.getBoundingClientRect()
  const width = mdTooltip.offsetWidth
  const height = mdTooltip.offsetHeight
  mdTooltip.style.left = clamp(rect.left + rect.width / 2 - width / 2, 8, window.innerWidth - width - 8) + "px"
  mdTooltip.style.top = (rect.top >= height + 10 ? rect.top - height - 7 : rect.bottom + 7) + "px"
}

// ---------------- 划选摘录 ----------------
const selMenu = document.getElementById("selMenu")
let selRect = null
selMenu.addEventListener("mousedown", (event) => {
  if (event.target.closest("button")) event.preventDefault()
})

function hideSelMenu() {
  selMenu.classList.remove("open")
}

function showSelMenu(rect) {
  const notebooks = state.graph.nodes.filter((n) => n.kind === "notebook")
  const linkedNotebook = state.selViewer
    ? state.graph.links
        .filter((link) => link.from === state.selViewer || link.to === state.selViewer)
        .map((link) => (link.from === state.selViewer ? link.to : link.from))
        .map((id) => state.nodesById.get(id))
        .find((node) => node?.kind === "notebook")
    : null
  const defaultTarget = linkedNotebook ? linkedNotebook.id : "__new__"
  selMenu.innerHTML = `
    <button id="selNewNode" class="primary" title="用摘录内容新建一个对话节点">用摘录新建对话</button>
    <button id="selCopy" title="复制选中的摘录文本">复制</button>
    ${state.selViewer ? '<button id="selAsk" title="将摘录填入当前会话输入框，不自动发送">询问</button>' : ""}
    <select id="selNb" title="选择目标笔记本">
      ${notebooks.map((n) => `<option value="${escapeHtml(n.id)}" ${n.id === defaultTarget ? "selected" : ""}>${escapeHtml(nodeDisplayTitle(n.id))}</option>`).join("")}
      <option value="__new__" ${defaultTarget === "__new__" ? "selected" : ""}>＋ 新建笔记本</option>
    </select>
    <button id="selNbAdd">摘录</button>
  `
  selRect = rect
  selMenu.classList.add("open")
  // 平铺时窗口 z-index 固定为 30/32，菜单必须更高，否则会被窗口盖住。
  selMenu.style.zIndex = String(Math.max(++windowLayer, 60))
  const mw = selMenu.offsetWidth || 320
  const mh = selMenu.offsetHeight || 40
  const { w, h } = viewport()
  selMenu.style.left = clamp(rect.left, 8, Math.max(8, w - mw - 8)) + "px"
  selMenu.style.top = clamp(rect.bottom + 6, 8, Math.max(8, h - mh - 8)) + "px"

  if (state.selViewer) selMenu.querySelector("#selAsk").onclick = async () => {
    const text = state.selText
    const nodeId = state.selViewer
    hideSelMenu()
    if (!text) return
    try {
      const viewer = await openContextViewer(nodeId)
      const quote = text.split("\n").map((line) => `> ${line}`).join("\n")
      fillContextPrompt(viewer, `${viewer.querySelector(".context-prompt").value.trim() ? "\n\n" : ""}请解释以下摘录：\n\n${quote}\n\n`)
    } catch (error) {
      statusEl.textContent = `无法准备询问: ${error.message}`
    }
  }

  selMenu.querySelector("#selNewNode").onclick = async () => {
    const text = state.selText
    hideSelMenu()
    if (!text) return
    try {
      const title = `摘录：${text.slice(0, 12).replace(/\n/g, " ")}`
      const node = await api("/nodes", {
        method: "POST",
        body: JSON.stringify({
          title,
          seed: `【摘录自「${state.selFrom ?? "未知"}」】\n\n${text}\n\n（以上为背景资料，请在此基础上继续。）`,
          workspaceId: state.activeWs || undefined,
          model: currentModel(),
          provisionalTitle: true,
        }),
      })
      await refresh()
      select({ type: "node", id: node.id })
      statusEl.textContent = `已用摘录新建对话节点「${title}」`
    } catch (error) {
      statusEl.textContent = "新建失败: " + error.message
    }
  }

  selMenu.querySelector("#selCopy").onclick = async () => {
    const text = state.selText
    hideSelMenu()
    if (!text) return
    const ok = await copyTextToClipboard(text)
    statusEl.textContent = ok ? "已复制摘录文本" : "复制失败，请手动复制"
  }

  selMenu.querySelector("#selNbAdd").onclick = async () => {
    const text = state.selText
    const pick = selMenu.querySelector("#selNb").value
    const fromNodeId = state.selViewer ?? null
    const messageId = state.selMid ?? null
    const offset = state.selOffset ?? 0
    hideSelMenu()
    if (!text) return
    try {
      let target = pick
      if (pick === "__new__" || !pick) {
        const nb = await createNotebook("摘录本")
        target = nb.id
      }
      const openViewer = notebookWindows.get(target)
      if (openViewer) await openViewer.flushNotebook?.()
      await api(`/nodes/${target}/excerpt`, {
        method: "POST",
        body: JSON.stringify({
          text,
          fromTitle: state.selFrom ?? undefined,
          fromNodeId: fromNodeId || undefined,
          messageId: messageId || undefined,
          offset,
        }),
      })
      if (fromNodeId && state.nodesById.has(fromNodeId) && fromNodeId !== target) {
        const linked = state.graph.links.some((link) =>
          (link.from === fromNodeId && link.to === target) || (link.from === target && link.to === fromNodeId))
        if (!linked) {
          try {
            await api("/links", { method: "POST", body: JSON.stringify({ from: fromNodeId, to: target, kind: "reference", directed: true }) })
          } catch (error) {
            statusEl.textContent = `摘录已保存，但建立连接失败: ${error.message}`
          }
        }
      }
      await refresh()
      if (openViewer && notebookWindows.get(target) === openViewer) reloadNotebookDoc(openViewer)
      select({ type: "node", id: target })
      statusEl.textContent = "已摘录到笔记本（保留原始 Markdown）"
    } catch (error) {
      statusEl.textContent = "摘录失败: " + error.message
    }
  }
}

document.addEventListener("mouseup", (event) => {
  if (selMenu.contains(event.target)) return
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return
  const text = rangeTextWithMath(sel.getRangeAt(0)).trim()
  if (!text) return
  const anchor = sel.anchorNode?.parentElement
  const focus = sel.focusNode?.parentElement
  if (!anchor || !focus || anchor.closest("textarea, input") || focus.closest("textarea, input")) return
  const viewer = anchor.closest(".context-viewer")
  state.selMid = null
  state.selOffset = 0
  if (viewer) {
    const start = anchor.closest(".context-message .msg-text")
    if (!start || start !== focus.closest(".context-message .msg-text")) return
    if (contextWindows.get(viewer.dataset.nodeId) !== viewer) return
    state.selViewer = viewer.dataset.nodeId
    state.selFrom = viewer.querySelector(".context-viewer-title").textContent.trim()
    const message = start.closest(".context-message")
    state.selMid = message?.dataset.mid ?? null
    try {
      const range = sel.getRangeAt(0).cloneRange()
      range.selectNodeContents(start)
      range.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset)
      state.selOffset = range.toString().length
    } catch {
      state.selOffset = 0
    }
  } else {
    if (!anchor.closest("#inspector") || !focus.closest("#inspector")) return
    state.selViewer = state.selection?.type === "node" ? state.selection.id : null
    state.selFrom = document.getElementById("inspectorTitle")?.textContent?.trim() || null
  }
  state.selText = text
  showSelMenu(sel.getRangeAt(0).getBoundingClientRect())
})

document.addEventListener("selectionchange", () => {
  const sel = window.getSelection()
  if ((!sel || sel.isCollapsed) && !selMenu.contains(document.activeElement)) hideSelMenu()
})

document.addEventListener("scroll", hideSelMenu, true)

// ---------------- 连线浮动菜单 ----------------
// 点击连线时在连线旁弹出，直接选择合并方向 / 派生新节点 / 删除。
function openLinkMenu(linkId) {
  const link = state.graph.links.find((l) => l.id === linkId)
  if (!link) return
  state.selectedLink = linkId
  state.hoverLink = linkId
  const a = nodeTitle(link.from)
  const b = nodeTitle(link.to)

  linkMenuEl.innerHTML = `
    <div class="lm-head"><b>${escapeHtml(a)}</b> ${link.directed ? "→" : "—"} <b>${escapeHtml(b)}</b></div>
    <button data-into="${escapeHtml(link.to)}" title="保留「${escapeHtml(b)}」，归档「${escapeHtml(a)}」">
      「${escapeHtml(a)}」并入「${escapeHtml(b)}」
    </button>
    <button data-into="${escapeHtml(link.from)}" title="保留「${escapeHtml(a)}」，归档「${escapeHtml(b)}」">
      「${escapeHtml(b)}」并入「${escapeHtml(a)}」
    </button>
    <button data-spawn class="primary">+ 新建节点（读取两端上下文）</button>
    <button data-del class="danger">删除连接</button>
    <div class="lm-hint">拖动另一个节点到此处可改接；双击节点可继续连线</div>
  `

  linkMenuEl.querySelectorAll("[data-into]").forEach((btn) => {
    btn.onclick = () => mergeLink(link, btn.dataset.into)
  })
  linkMenuEl.querySelector("[data-spawn]").onclick = () => spawnFromLink(link)
  linkMenuEl.querySelector("[data-del]").onclick = () => deleteLink(link)

  positionLinkMenu()
}

function closeLinkMenu() {
  state.selectedLink = null
  linkMenuEl.classList.remove("open")
}

function positionLinkMenu() {
  if (!state.selectedLink) return
  const link = state.graph.links.find((l) => l.id === state.selectedLink)
  const m = link ? linkMidpoint(state.positions, link) : null
  if (!m) {
    closeLinkMenu()
    return
  }
  const p = screenOf(m.x, m.y)
  const { w, h } = viewport()
  const mw = linkMenuEl.offsetWidth || 236
  const mh = linkMenuEl.offsetHeight || 130
  linkMenuEl.style.left = clamp(p.x + 16, 8, Math.max(8, w - mw - 8)) + "px"
  linkMenuEl.style.top = clamp(p.y - mh / 2, 8, Math.max(8, h - mh - 8)) + "px"
  linkMenuEl.classList.add("open")
}

async function mergeLink(link, intoId) {
  const fromId = intoId === link.from ? link.to : link.from
  if (!confirm(`将「${nodeTitle(fromId)}」合并进「${nodeTitle(intoId)}」？\n源节点会归档（保留可追溯）。`)) return
  try {
    const res = await api(`/links/${link.id}/merge`, {
      method: "POST",
      body: JSON.stringify({ into: intoId }),
    })
    closeLinkMenu()
    await refresh()
    select({ type: "node", id: intoId })
    statusEl.textContent = `已合并（${res.mergedBy}）：${nodeTitle(intoId)}`
  } catch (error) {
    statusEl.textContent = "合并失败: " + error.message
  }
}

async function spawnFromLink(link) {
  try {
    const res = await api(`/links/${link.id}/spawn`, { method: "POST", body: "{}" })
    closeLinkMenu()
    await refresh()
    select({ type: "node", id: res.node.id })
  } catch (error) {
    statusEl.textContent = "派生失败: " + error.message
  }
}

async function deleteLink(link) {
  if (!await confirmDanger("删除连接？", "这条连接将被永久删除，此操作无法撤销。", "删除连接")) return
  try {
    await api(`/links/${link.id}`, { method: "DELETE" })
    closeLinkMenu()
    state.selection = null
    await refresh()
  } catch (error) {
    statusEl.textContent = "删除失败: " + error.message
  }
}

// ---------------- 交互 ----------------
function hideCanvasMenu() {
  canvasMenu.hidden = true
}

function beginLasso(mx, my) {
  state.region = null
  hideCanvasMenu()
  state.lassoArmed = true
  state.lasso = { start: { x: mx, y: my }, points: [{ x: mx, y: my }], moved: false }
  state.hoverNode = null
  state.hoverLink = null
  state.hoverGhost = null
  nodeHoverInfo.classList.remove("open")
  canvas.classList.add("lasso-armed")
  canvas.style.cursor = ""
  draw()
}

function cancelLasso() {
  state.lasso = null
  state.lassoArmed = false
  canvas.classList.remove("lasso-armed")
  draw()
}

function clearRegion() {
  state.region = null
  state.regionDrag = null
  canvas.classList.remove("dragging")
  hideCanvasMenu()
  draw()
}

function hitRegion(mx, my) {
  return state.region && pointInPolygon(worldOf(mx, my), state.region.points)
}

/** 返回与给定节点直接或间接相连的全部节点（完整连接图）。 */
function connectedComponent(nodeId) {
  const adjacency = new Map()
  for (const link of state.graph.links) {
    if (!adjacency.has(link.from)) adjacency.set(link.from, [])
    if (!adjacency.has(link.to)) adjacency.set(link.to, [])
    adjacency.get(link.from).push(link.to)
    adjacency.get(link.to).push(link.from)
  }
  const seen = new Set([nodeId])
  const stack = [nodeId]
  while (stack.length) {
    const current = stack.pop()
    for (const next of adjacency.get(current) ?? []) {
      if (!seen.has(next) && state.nodesById.has(next)) {
        seen.add(next)
        stack.push(next)
      }
    }
  }
  return [...seen]
}

/** 用节点包围盒生成一个矩形选区多边形。 */
function regionPointsFor(nodeIds) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const id of nodeIds) {
    const position = state.positions.get(id)
    if (!position) continue
    const r = radiusOf(id) + 30
    minX = Math.min(minX, position.x - r)
    maxX = Math.max(maxX, position.x + r)
    minY = Math.min(minY, position.y - r)
    maxY = Math.max(maxY, position.y + r)
  }
  if (!Number.isFinite(minX)) return null
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ]
}

/** 全选当前页面可见节点，生成一个矩形选区。 */
function selectAllVisibleNodes() {
  const ids = visibleNodes().map((node) => node.id)
  const points = regionPointsFor(ids)
  if (!ids.length || !points) return
  state.region = { nodeIds: ids, points }
  state.selection = null
  state.lassoArmed = false
  canvas.classList.remove("lasso-armed")
  hideCanvasMenu()
  draw()
  statusEl.textContent = `已全选 ${ids.length} 个节点`
}

// ---------------- 布局撤销 ----------------
// 记录拖动 / 标准化 / 重新布局前的节点坐标，Ctrl+Z 回退上一步布局操作。
const layoutHistory = []
const LAYOUT_HISTORY_LIMIT = 50
function snapshotLayout() {
  return {
    positions: new Map([...state.positions].map(([id, p]) => [id, { ...p }])),
    anchors: new Map([...state.anchors].map(([id, p]) => [id, { ...p }])),
    pinned: new Set(state.pinned),
    saved: new Map([...savedPositions].map(([id, p]) => [id, { ...p }])),
  }
}
function pushLayoutHistory() {
  layoutHistory.push(snapshotLayout())
  if (layoutHistory.length > LAYOUT_HISTORY_LIMIT) layoutHistory.shift()
}
function undoLayout() {
  const snap = layoutHistory.pop()
  if (!snap) return false
  state.positions.clear()
  for (const [id, p] of snap.positions) state.positions.set(id, { ...p })
  state.anchors.clear()
  for (const [id, p] of snap.anchors) state.anchors.set(id, { ...p })
  state.pinned.clear()
  for (const id of snap.pinned) state.pinned.add(id)
  savedPositions.clear()
  for (const [id, p] of snap.saved) savedPositions.set(id, { ...p })
  persistLayoutsSoon()
  draw()
  return true
}

/** 选中某个节点的完整连接图，并弹出选区菜单。 */
function selectComponent(nodeId, mx, my) {
  const ids = connectedComponent(nodeId)
  const points = regionPointsFor(ids)
  if (!points) return
  state.region = { nodeIds: ids, points }
  state.selection = null
  state.lassoArmed = false
  canvas.classList.remove("lasso-armed")
  draw()
  statusEl.textContent = `已选中连接图：${ids.length} 个节点`
  const rect = canvas.getBoundingClientRect()
  openCanvasMenu({ clientX: rect.left + mx, clientY: rect.top + my }, null, mx, my, true)
}

/** 标准化选区布局：保持连接不变，分层排列并消除重叠与交叉。 */
function standardizeRegion() {
  const ids = state.region?.nodeIds.filter((id) => state.nodesById.has(id)) ?? []
  if (!ids.length) return
  pushLayoutHistory()
  const idSet = new Set(ids)
  const nodes = state.graph.nodes.filter((node) => idSet.has(node.id))
  const links = state.graph.links.filter((link) => idSet.has(link.from) && idSet.has(link.to))
  standardizeLayout({ nodes, links, positions: state.positions, radiusOf })
  for (const id of ids) {
    const position = state.positions.get(id)
    if (!position) continue
    state.anchors.set(id, { ...position })
    state.pinned.add(id)
    savedPositions.set(id, { ...position })
  }
  savePinnedPositions()
  draw()
  statusEl.textContent = `已标准化 ${ids.length} 个节点的布局`
}

function confirmDanger(title, text, action) {
  deleteNodeDialog.querySelector("#deleteNodeTitle").textContent = title
  deleteNodeDialog.querySelector("#deleteNodeText").textContent = text
  deleteNodeDialog.querySelector('[value="delete"]').textContent = action
  deleteNodeDialog.returnValue = "cancel"
  deleteNodeDialog.showModal()
  deleteNodeDialog.querySelector('[value="cancel"]').focus()
  return new Promise((resolve) => deleteNodeDialog.addEventListener("close", () => resolve(deleteNodeDialog.returnValue === "delete"), { once: true }))
}

/** 通用确认弹窗，可选「下次不再提醒」勾选项。返回 { ok, remember }。 */
function confirmAction({ title, text, action = "确定", alt = null, remember = null, rememberDefault = true } = {}) {
  confirmDialog.querySelector("#confirmDialogTitle").textContent = title
  confirmDialog.querySelector("#confirmDialogText").textContent = text
  confirmDialog.querySelector("#confirmDialogOk").textContent = action
  const altButton = confirmDialog.querySelector("#confirmDialogAlt")
  altButton.hidden = !alt
  if (alt) altButton.textContent = alt
  const wrap = confirmDialog.querySelector("#confirmDialogRemember")
  const check = confirmDialog.querySelector("#confirmDialogRememberCheck")
  if (remember) {
    wrap.hidden = false
    confirmDialog.querySelector("#confirmDialogRememberLabel").textContent = remember
    check.checked = rememberDefault
  } else {
    wrap.hidden = true
    check.checked = false
  }
  confirmDialog.returnValue = "cancel"
  confirmDialog.showModal()
  confirmDialog.querySelector('[value="cancel"]').focus()
  return new Promise((resolve) => confirmDialog.addEventListener("close", () => {
    resolve({
      ok: confirmDialog.returnValue === "confirm",
      alt: confirmDialog.returnValue === "secondary",
      remember: remember ? check.checked : false,
    })
  }, { once: true }))
}

const newNodeDialog = document.getElementById("newNodeDialog")

function promptNewNode({ title = "新建节点", text = "", defaultName = "新节点" } = {}) {
  const input = newNodeDialog.querySelector("#newNodeDialogName")
  newNodeDialog.querySelector("#newNodeDialogTitle").textContent = title
  const textEl = newNodeDialog.querySelector("#newNodeDialogText")
  textEl.textContent = text
  textEl.hidden = !text
  input.value = defaultName
  newNodeDialog.querySelector("#newNodeDialogError").textContent = ""
  newNodeDialog.returnValue = "cancel"
  newNodeDialog.showModal()
  input.focus()
  input.select()
  return new Promise((resolve) => newNodeDialog.addEventListener("close", () => {
    resolve({ ok: newNodeDialog.returnValue === "confirm", name: input.value.trim() })
  }, { once: true }))
}

function validateNewNodeName() {
  const input = newNodeDialog.querySelector("#newNodeDialogName")
  const name = input.value.trim()
  if (!name) {
    newNodeDialog.querySelector("#newNodeDialogError").textContent = "请输入节点名称"
    input.focus()
    return null
  }
  return name
}

newNodeDialog.querySelector("form").addEventListener("submit", (event) => {
  event.preventDefault()
  const name = validateNewNodeName()
  if (!name) return
  newNodeDialog.querySelector("#newNodeDialogName").value = name
  newNodeDialog.close("confirm")
})
newNodeDialog.querySelector("#newNodeDialogCancel").onclick = () => newNodeDialog.close("cancel")
newNodeDialog.querySelector("#newNodeDialogName").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return
  event.preventDefault()
  const name = validateNewNodeName()
  if (!name) return
  newNodeDialog.querySelector("#newNodeDialogName").value = name
  newNodeDialog.close("confirm")
})

// ---------------- /new_compose：为未连接节点新建协作模板 ----------------
const newComposeDialog = document.getElementById("newComposeDialog")
const newComposeKind = document.getElementById("newComposeKind")
const newComposeConfig = document.getElementById("newComposeConfig")
let newComposeNodeId = null

/** 按结构与人数组出角色标签，用于预览协作规模。 */
function composeRoleLabels(kind, config) {
  if (kind === "three-ministries") {
    return ["皇帝", ...config.layers.flatMap((size, level) => Array.from({ length: size }, (_, index) => `第${level + 1}层 ${index + 1}`))]
  }
  if (kind === "brainstorm") {
    return ["主持", ...Array.from({ length: config.agents }, (_, index) => `发散 ${index + 1}`)]
  }
  return ["主持", ...Array.from({ length: config.sides }, (_, side) => Array.from({ length: config.perSide }, (_, index) => `第${side + 1}方 ${index + 1}辩`)).flat(), "评审"]
}

function updateNewComposeSummary() {
  const el = document.getElementById("newComposeSummary")
  try {
    const config = collaborationConfig(newComposeKind.value, newComposeConfig)
    const numbers = newComposeKind.value === "three-ministries" ? config.layers : newComposeKind.value === "brainstorm" ? [config.agents] : [config.sides, config.perSide]
    if (!numbers.length || !numbers.every((value) => Number.isInteger(value) && value >= 1 && value <= 12)) throw new Error("bad")
    const labels = composeRoleLabels(newComposeKind.value, config)
    el.textContent = `共 ${labels.length} 个角色：${labels.slice(0, 8).join("、")}${labels.length > 8 ? "…" : ""}`
    el.classList.remove("error")
  } catch {
    el.textContent = "人数设置无效"
    el.classList.add("error")
  }
}

function renderNewComposeConfig() {
  newComposeConfig.innerHTML = configFields(newComposeKind.value)
  newComposeConfig.querySelectorAll("input").forEach((input) => input.addEventListener("input", updateNewComposeSummary))
  updateNewComposeSummary()
}

function openNewComposeDialog(nodeId) {
  newComposeNodeId = nodeId
  newComposeKind.value = "three-ministries"
  document.getElementById("newComposeName").value = ""
  document.getElementById("newComposeError").textContent = ""
  renderNewComposeConfig()
  newComposeDialog.returnValue = "cancel"
  newComposeDialog.showModal()
}

newComposeKind.onchange = renderNewComposeConfig
document.getElementById("newComposeCancel").onclick = () => newComposeDialog.close("cancel")
newComposeDialog.querySelector("form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const button = document.getElementById("newComposeOk")
  const errorEl = document.getElementById("newComposeError")
  errorEl.textContent = ""
  const nodeId = newComposeNodeId
  if (!nodeId) { newComposeDialog.close("cancel"); return }
  let config
  try { config = collaborationConfig(newComposeKind.value, newComposeConfig) } catch { errorEl.textContent = "人数设置无效"; return }
  button.disabled = true
  try {
    const item = await api("/collaborations", {
      method: "POST",
      body: JSON.stringify({
        kind: newComposeKind.value,
        name: document.getElementById("newComposeName").value.trim(),
        config,
        nodeIds: [nodeId],
        workspaceId: state.activeWs || undefined,
      }),
    })
    await refresh()
    await loadTemplates()
    positionCollaboration(item)
    newComposeDialog.close("confirm")
    statusEl.textContent = `已创建协作模板「${item.name}」，${item.slots.length} 个角色；用 /compose 任务 启动`
  } catch (error) {
    errorEl.textContent = error.message
  } finally {
    button.disabled = false
  }
})

async function deleteRegion() {
  const ids = state.region?.nodeIds.filter((id) => state.nodesById.has(id)) ?? []
  if (!ids.length) return clearRegion()
  const connections = state.graph.links.filter((link) => ids.includes(link.from) || ids.includes(link.to)).length
  if (!await confirmDanger("删除选中区域？", `将永久删除 ${ids.length} 个节点、关联会话及 ${connections} 条连接，此操作无法撤销。`, "删除选中区域")) return
  let deleted = 0
  let failure = null
  try {
    for (const id of ids) {
      const openViewer = notebookWindows.get(id)
      if (openViewer) await openViewer.flushNotebook?.()
      await api(`/nodes/${id}`, { method: "DELETE" })
      deleted++
      if (openViewer && notebookWindows.get(id) === openViewer) closeNotebookViewer(openViewer)
    }
    clearRegion()
  } catch (error) {
    failure = error
  } finally {
    await refresh().catch((error) => { failure ??= error })
  }
  statusEl.textContent = failure
    ? `已删除 ${deleted}/${ids.length} 个节点；删除失败: ${failure.message}`
    : `已删除选中区域的 ${deleted} 个节点及关联连接`
}

async function createWorkspaceFromLasso(nodeIds) {
  if (!nodeIds.length) { statusEl.textContent = "圈选范围内没有节点"; return }
  try { await refresh() } catch (error) { statusEl.textContent = `页面加载失败: ${error.message}`; return }
  const choice = await chooseWorkspaceForLasso(nodeIds.length)
  if (!choice) return
  let ws
  let joined = 0
  let remaining = nodeIds.length
  try {
    if (choice.mode === "new") {
      ws = await api("/workspaces", { method: "POST", body: JSON.stringify({ name: choice.name, color: resolveWorkspaceColor() }) })
    } else {
      ws = state.graph.workspaces.find((workspace) => workspace.id === choice.workspaceId)
      if (!ws) { statusEl.textContent = "目标页面不存在，请刷新后重试"; return }
    }
    const existingMembers = new Set(state.graph.members.filter((member) => member.workspaceId === ws.id).map((member) => member.nodeId))
    remaining = nodeIds.filter((nodeId) => !existingMembers.has(nodeId)).length
    for (const nodeId of nodeIds) {
      if (existingMembers.has(nodeId)) continue
      await api(`/workspaces/${ws.id}/members`, { method: "POST", body: JSON.stringify({ nodeId, action: "join" }) })
      joined++
    }
    await refresh()
    switchPage(ws.id)
    statusEl.textContent = choice.mode === "new"
      ? `已创建页面「${ws.name}」，包含 ${nodeIds.length} 个节点`
      : `页面「${ws.name}」现包含本次圈选的 ${nodeIds.length} 个节点（新增 ${joined} 个）`
  } catch (error) {
    await refresh().catch(() => {})
    statusEl.textContent = ws
      ? `页面「${ws.name}」已处理，但仅新增 ${joined}/${remaining} 个节点: ${error.message}`
      : `页面处理失败: ${error.message}`
  }
}

function chooseWorkspaceForLasso(nodeCount) {
  const form = document.getElementById("lassoWorkspaceForm")
  const nameInput = document.getElementById("lassoWorkspaceName")
  const select = document.getElementById("lassoWorkspaceSelect")
  const text = document.getElementById("lassoWorkspaceText")
  const radios = [...form.querySelectorAll('input[name="lassoTarget"]')]
  const existingRadio = form.querySelector('input[name="lassoTarget"][value="existing"]')
  text.textContent = `已圈选 ${nodeCount} 个节点，选择新建页面或加入已有页面。`
  nameInput.value = `页面 ${state.graph.workspaces.length + 1}`
  select.innerHTML = state.graph.workspaces.map((workspace) => `<option value="${escapeHtml(workspace.id)}">${escapeHtml(workspace.name)}</option>`).join("")
  select.value = state.graph.workspaces[0]?.id ?? ""
  existingRadio.disabled = state.graph.workspaces.length === 0
  form.querySelector('input[name="lassoTarget"][value="new"]').checked = true
  const updateDisabled = () => {
    const existing = form.querySelector('input[name="lassoTarget"]:checked')?.value === "existing"
    nameInput.disabled = existing
    select.disabled = !state.graph.workspaces.length
  }
  radios.forEach((radio) => { radio.onchange = updateDisabled })
  select.onfocus = select.onchange = () => { existingRadio.checked = true; updateDisabled() }
  updateDisabled()
  lassoWorkspaceDialog.returnValue = "cancel"
  lassoWorkspaceDialog.showModal()
  nameInput.focus()
  return new Promise((resolve) => {
    form.onsubmit = (event) => {
      event.preventDefault()
      const result = event.submitter?.value
      if (result !== "confirm") { lassoWorkspaceDialog.close("cancel"); resolve(null); return }
      const mode = form.querySelector('input[name="lassoTarget"]:checked')?.value
      if (mode === "existing") {
        if (!select.value) { statusEl.textContent = "请选择已有页面"; return }
        lassoWorkspaceDialog.close("confirm")
        resolve({ mode: "existing", workspaceId: select.value })
        return
      }
      const name = nameInput.value.trim()
      if (!name) { statusEl.textContent = "页面名称不能为空"; return }
      lassoWorkspaceDialog.close("confirm")
      resolve({ mode: "new", name })
    }
    lassoWorkspaceDialog.addEventListener("close", () => {
      if (lassoWorkspaceDialog.returnValue !== "confirm") resolve(null)
    }, { once: true })
  })
}

function openCanvasMenu(event, node, mx, my, region = false) {
  canvasMenu.nodeId = node?.id ?? null
  canvasMenu.pointer = { x: mx, y: my }
  canvasMenu.position = node ? null : worldOf(mx, my)
  canvasMenu.querySelector("#canvasNewNode").hidden = Boolean(node || region)
  canvasMenu.querySelector("#canvasNewNotebook").hidden = Boolean(node || region)
  canvasMenu.querySelector("#canvasRegionActions").hidden = !region
  canvasMenu.querySelector("#canvasNodeActions").hidden = !node || region
  canvasMenu.querySelector("#canvasNodeEdit").hidden = true
  canvasMenu.querySelector("#canvasNodeTitle").textContent = node?.title ?? ""
  nodeHoverInfo.classList.remove("open")
  canvasMenu.hidden = false
  canvasMenu.style.left = clamp(event.clientX, 8, Math.max(8, window.innerWidth - canvasMenu.offsetWidth - 8)) + "px"
  canvasMenu.style.top = clamp(event.clientY, 8, Math.max(8, window.innerHeight - canvasMenu.offsetHeight - 8)) + "px"
  canvasMenu.querySelector(region ? "#canvasRegionJoin" : node ? "#canvasNodeConnect" : "#canvasNewNode").focus()
}

canvas.addEventListener("contextmenu", (event) => event.preventDefault())

function editCanvasNode(field) {
  const node = state.nodesById.get(canvasMenu.nodeId)
  if (!node) { hideCanvasMenu(); return }
  canvasMenu.editField = field
  canvasMenu.querySelector("#canvasNodeActions").hidden = true
  canvasMenu.querySelector("#canvasNodeEdit").hidden = false
  canvasMenu.querySelector("#canvasEditLabel").textContent = "节点标题"
  canvasMenu.querySelector("#canvasEditError").textContent = ""
  const input = canvasMenu.querySelector("#canvasEditValue")
  input.value = node[field] ?? ""
  input.focus()
  input.select()
}

function confirmDeleteNode(node) {
  return confirmDanger("删除节点？", node.kind === "notebook"
    ? `将永久删除笔记本「${node.title}」及其连接，此操作无法撤销。`
    : `将永久删除「${node.title}」、关联会话及连接，此操作无法撤销。`, "删除节点")
}

async function deleteNodeWithConfirmation(nodeId) {
  const node = state.nodesById.get(nodeId)
  if (!node || !await confirmDeleteNode(node)) return
  try {
    const openNotebook = notebookWindows.get(nodeId)
    if (openNotebook) await openNotebook.flushNotebook?.()
    await api(`/nodes/${nodeId}`, { method: "DELETE" })
    if (openNotebook && notebookWindows.get(nodeId) === openNotebook) closeNotebookViewer(openNotebook)
    if (state.selection?.id === nodeId) {
      state.selection = null
      hidePanel()
    }
    await refresh()
    statusEl.textContent = `已删除「${node.title}」`
  } catch (error) {
    statusEl.textContent = `删除失败: ${error.message}`
  }
}

canvasMenu.querySelector("#canvasNewNode").onclick = () => {
  const position = canvasMenu.position
  hideCanvasMenu()
  void createConversationNode(position)
}
canvasMenu.querySelector("#canvasNewNotebook").onclick = () => {
  const position = canvasMenu.position
  hideCanvasMenu()
  void createNotebook("未命名笔记本", position).catch((error) => (statusEl.textContent = "新建笔记本失败: " + error.message))
}
canvasMenu.querySelector("#canvasNodeJoin").onclick = () => {
  const nodeId = canvasMenu.nodeId
  hideCanvasMenu()
  if (state.nodesById.has(nodeId)) void createWorkspaceFromLasso([nodeId])
}
canvasMenu.querySelector("#canvasNodeCopyIdentity").onclick = async () => {
  const node = state.nodesById.get(canvasMenu.nodeId)
  if (!node) { hideCanvasMenu(); return }
  hideCanvasMenu()
  try {
    await navigator.clipboard.writeText(`节点 ID: ${node.id}\n节点名称: ${node.title}`)
    statusEl.textContent = `已复制节点「${node.title}」的 ID 和名称`
  } catch (error) {
    statusEl.textContent = `复制节点信息失败: ${error.message}`
  }
}
canvasMenu.querySelector("#canvasNodeConnect").onclick = () => {
  const nodeId = canvasMenu.nodeId
  const { x, y } = canvasMenu.pointer
  hideCanvasMenu()
  if (state.nodesById.has(nodeId)) startConnect(nodeId, x, y)
}
canvasMenu.querySelector("#canvasNodeNewChild").onclick = () => {
  const nodeId = canvasMenu.nodeId
  hideCanvasMenu()
  if (!state.nodesById.has(nodeId)) return
  void promptNewNode({ title: "创建子节点", text: `将新建子节点并连接到「${nodeTitle(nodeId)}」`, defaultName: "子节点" })
    .then(({ ok, name }) => { if (ok) void createNodeAt(childPosition(nodeId), { fromId: nodeId, name }) })
}
canvasMenu.querySelector("#canvasNodeSelectComponent").onclick = () => {
  const nodeId = canvasMenu.nodeId
  const pointer = canvasMenu.pointer
  hideCanvasMenu()
  if (state.nodesById.has(nodeId)) selectComponent(nodeId, pointer.x, pointer.y)
}
canvasMenu.querySelector("#canvasNodeRename").onclick = () => editCanvasNode("title")
canvasMenu.querySelector("#canvasEditCancel").onclick = hideCanvasMenu
canvasMenu.querySelector("#canvasNodeEdit").onsubmit = async (event) => {
  event.preventDefault()
  const nodeId = canvasMenu.nodeId
  const field = canvasMenu.editField
  const input = canvasMenu.querySelector("#canvasEditValue").value.trim()
  const value = input
  const errorEl = canvasMenu.querySelector("#canvasEditError")
  if (field === "title" && !value) { errorEl.textContent = "标题不能为空"; return }
  if (!state.nodesById.has(nodeId)) { hideCanvasMenu(); return }
  const button = canvasMenu.querySelector("#canvasEditSave")
  button.disabled = true
  try {
    await api(`/nodes/${nodeId}`, { method: "PATCH", body: JSON.stringify({ [field]: value }) })
    hideCanvasMenu()
    await refresh()
    if (field === "title" && notebookWindows.has(nodeId)) {
      renderNotebookTitle(notebookWindows.get(nodeId), state.nodesById.get(nodeId))
    }
    if (panel.classList.contains("open") && state.selection?.id === nodeId) await openNodePanel(nodeId)
  } catch (error) {
    errorEl.textContent = error.message
  } finally {
    button.disabled = false
  }
}
canvasMenu.querySelector("#canvasNodeDelete").onclick = () => {
  const nodeId = canvasMenu.nodeId
  hideCanvasMenu()
  void deleteNodeWithConfirmation(nodeId)
}
canvasMenu.querySelector("#canvasRegionJoin").onclick = () => {
  const ids = [...state.region?.nodeIds ?? []]
  hideCanvasMenu()
  void createWorkspaceFromLasso(ids)
}
canvasMenu.querySelector("#canvasRegionStandardize").onclick = () => {
  hideCanvasMenu()
  standardizeRegion()
}
canvasMenu.querySelector("#canvasRegionDelete").onclick = () => { hideCanvasMenu(); void deleteRegion() }
canvasMenu.querySelector("#canvasRegionCancel").onclick = clearRegion
document.addEventListener("pointerdown", (event) => {
  if (!canvasMenu.contains(event.target)) hideCanvasMenu()
})

function hidePanel() {
  state.panelDetached = false
  panel.classList.remove("open")
  panel.style.zIndex = ""
}

function select(obj) {
  if (obj?.type === "node" && state.nodesById.get(obj.id)?.kind === "notebook") {
    openNodePanel(obj.id).catch((error) => (statusEl.textContent = error.message))
    return
  }
  state.selection = obj
  if (obj?.type === "node") {
    closeLinkMenu()
    hidePanel()
    openContextViewer(obj.id).catch((error) => (statusEl.textContent = error.message))
  } else if (obj?.type === "link") {
    hidePanel()
    openLinkMenu(obj.id)
  } else {
    hidePanel()
    closeLinkMenu()
  }
  draw()
}

function startConnect(nodeId, mx, my) {
  const world = worldOf(mx, my)
  state.connect = { from: nodeId, x: world.x, y: world.y, targetId: null }
  app.classList.add("canvas-interacting")
  canvas.classList.add("connecting")
  // 双击进入连线时，第一次单击可能刚打开了该节点窗口；这不是用户本意，随手关掉。
  const opened = contextWindows.get(nodeId)
  if (opened && Date.now() - (opened.openedAt ?? 0) < 700) closeContextViewer(opened)
  // 双击节点直接进入连线：隐去详情弹窗，避免遮挡画布
  state.selection = null
  hidePanel()
  closeLinkMenu()
  draw()
}

function cancelConnect() {
  state.connect = null
  app.classList.remove("canvas-interacting")
  canvas.classList.remove("connecting")
  draw()
}

async function completeConnect(targetId) {
  const from = state.connect.from
  state.connect = null
  app.classList.remove("canvas-interacting")
  canvas.classList.remove("connecting")
  try {
    const existing = state.graph.links.find(
      (l) => (l.from === from && l.to === targetId) || (l.from === targetId && l.to === from),
    )
    if (existing) {
      // 已有连接则不重复创建，直接弹出该连接的菜单
      select({ type: "link", id: existing.id })
      return
    }
    const created = await api("/links", {
      method: "POST",
      body: JSON.stringify({ from, to: targetId, kind: "reference", directed: true }),
    })
    await refresh()
    select({ type: "link", id: created.id })
  } catch (error) {
    statusEl.textContent = "建立连接失败: " + error.message
    draw()
  }
}

canvas.addEventListener("mousedown", (e) => {
  if (e.button === 2) {
    hideCanvasMenu()
    if (state.lassoArmed) cancelLasso()
    if (state.connect || state.drag || state.pan) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const region = Boolean(hitRegion(mx, my))
    if (hitTestGhost(mx, my)) return
    const node = region ? null : hitTestNode(mx, my)
    if (!node && !region && hitTestAnyLink(mx, my)) return
    state.rightClick = { nodeId: node?.id ?? null, region, start: { x: mx, y: my } }
    nodeHoverInfo.classList.remove("open")
    e.preventDefault()
    return
  }
  if (e.button !== 0) return
  nodeHoverInfo.classList.remove("open")
  const rect = canvas.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top

  // 已处于连线模式：点目标节点完成连线，点空白处新建并连接，点起点取消
  if (state.connect) {
    const target = hitTestNode(mx, my)
    if (target && target.id !== state.connect.from) { completeConnect(target.id); return }
    if (target) { cancelConnect(); return }
    const fromId = state.connect.from
    const world = worldOf(mx, my)
    cancelConnect()
    void promptNewNode({ title: "新建节点", text: `将新建节点并连接到「${nodeTitle(fromId)}」`, defaultName: "新节点" })
      .then(({ ok, name }) => { if (ok) void createNodeAt(world, { fromId, name }) })
    return
  }

  if (state.lassoArmed) { beginLasso(mx, my); return }

  if (hitRegion(mx, my)) {
    const start = worldOf(mx, my)
    state.regionDrag = {
      start, mx, my, moved: false,
      points: state.region.points.map((point) => ({ ...point })),
      positions: new Map(state.region.nodeIds.map((id) => [id, { ...state.positions.get(id) }])),
    }
    canvas.classList.add("dragging")
    canvas.style.cursor = "grabbing"
    return
  }
  if (state.region) clearRegion()

  // 幽灵节点：点击跳到对方所在页面
  const ghost = hitTestGhost(mx, my)
  if (ghost) {
    gotoNode(ghost.id)
    return
  }

  const node = hitTestNode(mx, my)
  if (node) {
    // 双击节点 = 拉出连接；Shift + 单击同样进入连线模式
    if (e.shiftKey || e.detail >= 2) {
      startConnect(node.id, mx, my)
      return
    }
    const p = state.positions.get(node.id)
    const world = worldOf(mx, my)
    state.drag = { nodeId: node.id, dx: world.x - p.x, dy: world.y - p.y, mx, my, moved: false }
    canvas.classList.add("dragging")
    canvas.style.cursor = "grabbing"
    return
  }

  const link = hitTestAnyLink(mx, my)
  if (link) {
    select({ type: "link", id: link.id })
    return
  }

  if (e.detail >= 2) {
    select(null)
    beginLasso(mx, my)
    return
  }
  select(null)
  state.pan = { mx, my, cx: state.camera.x, cy: state.camera.y }
  canvas.classList.add("panning")
  canvas.style.cursor = "grabbing"
})

window.addEventListener("mousemove", (event) => {
  const gesture = state.lasso
  if (!gesture) return
  const rect = canvas.getBoundingClientRect()
  const point = { x: clamp(event.clientX - rect.left, 0, rect.width), y: clamp(event.clientY - rect.top, 0, rect.height) }
  const last = gesture.points.at(-1)
  if (Math.hypot(point.x - last.x, point.y - last.y) < 3) return
  gesture.points.push(point)
  if (Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) >= 8) gesture.moved = true
  if (gesture.moved) draw()
})

window.addEventListener("mouseup", (event) => {
  if (event.button !== 0) return
  const gesture = state.lasso
  state.lasso = null
  if (!gesture) return
  const rect = canvas.getBoundingClientRect()
  const point = { x: clamp(event.clientX - rect.left, 0, rect.width), y: clamp(event.clientY - rect.top, 0, rect.height) }
  if (Math.hypot(point.x - gesture.points.at(-1).x, point.y - gesture.points.at(-1).y) >= 3) gesture.points.push(point)
  if (Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) >= 8) gesture.moved = true
  if (gesture.moved) {
    const nodeIds = visibleNodes().filter((node) => {
      const position = state.positions.get(node.id)
      return position && pointInPolygon(screenOf(position.x, position.y), gesture.points)
    }).map((node) => node.id)
    state.lassoArmed = false
    canvas.classList.remove("lasso-armed")
    if (nodeIds.length) {
      state.region = { nodeIds, points: gesture.points.map((p) => worldOf(p.x, p.y)) }
      statusEl.textContent = `已圈选 ${nodeIds.length} 个节点`
    } else statusEl.textContent = "圈选范围内没有节点"
  }
  draw()
})

window.addEventListener("mouseup", (event) => {
  if (event.button !== 2) return
  const click = state.rightClick
  state.rightClick = null
  if (!click || event.target !== canvas) return
  const rect = canvas.getBoundingClientRect()
  if (Math.hypot(event.clientX - rect.left - click.start.x, event.clientY - rect.top - click.start.y) >= 8) return
  const node = click.nodeId ? state.nodesById.get(click.nodeId) : null
  openCanvasMenu(event, node, click.start.x, click.start.y, click.region)
})
window.addEventListener("blur", () => { state.rightClick = null; if (state.lassoArmed) cancelLasso() })

canvas.addEventListener("mousemove", (e) => {
  if (state.lassoArmed || state.rightClick) return
  const rect = canvas.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top

  if (state.regionDrag || state.drag || state.pan) canvas.style.cursor = "grabbing"
  else if (state.connect) canvas.style.cursor = "crosshair"

  if (state.regionDrag) {
    const drag = state.regionDrag
    if (!drag.moved && Math.hypot(mx - drag.mx, my - drag.my) < 5) return
    if (!drag.moved) { pushLayoutHistory(); app.classList.add("canvas-interacting") }
    drag.moved = true
    const world = worldOf(mx, my)
    const dx = world.x - drag.start.x, dy = world.y - drag.start.y
    state.region.points = drag.points.map((point) => ({ x: point.x + dx, y: point.y + dy }))
    for (const [id, point] of drag.positions) {
      const p = { x: point.x + dx, y: point.y + dy }
      state.positions.set(id, p)
      state.anchors.set(id, { ...p })
      state.pinned.add(id)
    }
    draw()
    return
  }

  if (state.drag) {
    if (!state.drag.moved && Math.hypot(mx - state.drag.mx, my - state.drag.my) < 5) return
    if (!state.drag.moved) { pushLayoutHistory(); app.classList.add("canvas-interacting") }
    state.drag.moved = true
    const world = worldOf(mx, my)
    const p = { x: world.x - state.drag.dx, y: world.y - state.drag.dy }
    state.positions.set(state.drag.nodeId, p)
    state.anchors.set(state.drag.nodeId, { ...p })
    state.pinned.add(state.drag.nodeId)
    draw()
    return
  }

  if (state.connect) {
    const world = worldOf(mx, my)
    const target = hitTestNode(mx, my)
    state.connect.x = world.x
    state.connect.y = world.y
    state.connect.targetId = target && target.id !== state.connect.from ? target.id : null
    if (state.connect.targetId) state.connect.moved = true
    draw()
    return
  }

  if (state.pan) {
    state.camera.x = state.pan.cx - (mx - state.pan.mx) / state.camera.zoom
    state.camera.y = state.pan.cy - (my - state.pan.my) / state.camera.zoom
    saveCameraSoon()
    draw()
    return
  }

  // 悬停反馈：幽灵/连线/节点都可点
  const ghost = hitTestGhost(mx, my)
  const link = ghost ? null : hitTestAnyLink(mx, my)
  const node = ghost || link ? null : hitTestNode(mx, my)
  const hoverGhost = ghost?.id ?? null
  const hoverLink = link?.id ?? null
  const hoverNode = node?.id ?? null
  state.hoverPosition = { x: e.clientX, y: e.clientY }
  if (hoverNode) updateNodeHoverInfo(hoverNode)
  else nodeHoverInfo.classList.remove("open")
  canvas.style.cursor = (state.pan || state.drag || state.regionDrag || state.lasso)
    ? "grabbing"
    : state.connect ? "crosshair"
    : hoverGhost || hoverLink || hoverNode ? "pointer"
    : hitRegion(mx, my) ? "move" : "grab"
  if (
    hoverGhost !== state.hoverGhost ||
    hoverLink !== state.hoverLink ||
    hoverNode !== state.hoverNode
  ) {
    state.hoverGhost = hoverGhost
    state.hoverLink = hoverLink
    state.hoverNode = hoverNode
    draw()
  }
})

async function endInteraction(event) {
  if (state.lasso) return
  canvas.style.cursor = ""
  if (state.regionDrag) {
    const drag = state.regionDrag
    state.regionDrag = null
    app.classList.remove("canvas-interacting")
    canvas.classList.remove("dragging")
    if (drag.moved) {
      for (const id of drag.positions.keys()) savedPositions.set(id, { ...state.positions.get(id) })
      savePinnedPositions()
    } else if (event?.type === "mouseup") {
      const rect = canvas.getBoundingClientRect()
      openCanvasMenu(event, null, event.clientX - rect.left, event.clientY - rect.top, true)
    }
    draw()
    return
  }
  if (state.connect) {
    const { from, targetId, moved } = state.connect
    // 拖到目标节点松手 → 完成；未移动（双击模式）→ 保持连线模式等待下一次点击
    if (targetId && targetId !== from) {
      await completeConnect(targetId)
    } else if (moved) {
      cancelConnect()
    }
    return
  }
  const drag = state.drag
  state.drag = null
  state.pan = null
  app.classList.remove("canvas-interacting")
  canvas.classList.remove("dragging", "panning")
  if (drag && !drag.moved) {
    select({ type: "node", id: drag.nodeId })
  }
  if (drag?.moved && state.positions.has(drag.nodeId)) {
    savedPositions.set(drag.nodeId, { ...state.positions.get(drag.nodeId) })
    savePinnedPositions()
  }
}
canvas.addEventListener("mouseup", endInteraction)
canvas.addEventListener("mouseleave", () => {
  state.hoverPosition = null
  nodeHoverInfo.classList.remove("open")
  canvas.style.cursor = ""
  if (state.drag) state.drag.moved = true
  endInteraction({ type: "mouseleave" })
})

canvas.addEventListener("wheel", (e) => {
  e.preventDefault()
  hideCanvasMenu()
  const rect = canvas.getBoundingClientRect()
  zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12)
  draw()
}, { passive: false })

document.getElementById("closeInspector").onclick = () => {
  state.selection = null
  hidePanel()
  draw()
}
new ResizeObserver(() => {
  if (!panel.classList.contains("open")) return
  const rect = panel.getBoundingClientRect()
  if (rect.width && rect.height) localStorage.setItem("nodex.settingsSize", JSON.stringify({ w: Math.round(rect.width), h: Math.round(rect.height) }))
}).observe(panel)
panel.querySelector(".inspector-bar").addEventListener("pointerdown", (event) => {
  if (event.target.closest("button")) return
  const bar = event.currentTarget
  const rect = panel.getBoundingClientRect()
  const dx = event.clientX - rect.left, dy = event.clientY - rect.top
  bar.setPointerCapture(event.pointerId)
  const move = (e) => {
    state.panelDetached = true
    panel.style.left = clamp(e.clientX - dx, 0, window.innerWidth - 48) + "px"
    panel.style.top = clamp(e.clientY - dy, 0, window.innerHeight - 40) + "px"
  }
  const stop = () => bar.removeEventListener("pointermove", move)
  bar.addEventListener("pointermove", move)
  bar.addEventListener("pointerup", stop, { once: true })
  bar.addEventListener("pointercancel", stop, { once: true })
})
function attachNotebookWindow(viewer) {
  viewer.addEventListener("pointerdown", (event) => {
    if (!shouldSkipWindowFocus(viewer, event.target)) focusContextViewer(viewer)
    if (!event.target.closest(".notebook-viewer-ai, .nb-ai-menu")) closeNotebookAiMenu(viewer)
    const rect = viewer.getBoundingClientRect()
    if (tiledWindowPositions || viewer.classList.contains("maximized") || event.clientX < rect.right - 22 || event.clientY < rect.bottom - 22) return
    const finish = () => {
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", finish)
      if (!viewer.isConnected) return
      const next = viewer.getBoundingClientRect()
      if (Math.abs(next.width - rect.width) < 2 && Math.abs(next.height - rect.height) < 2) return
      localStorage.setItem("nodex.notebookSize", JSON.stringify({ w: Math.round(next.width), h: Math.round(next.height) }))
    }
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", finish)
  })
  viewer.querySelector(".notebook-viewer-close").onclick = () => closeNotebookViewer(viewer)
  viewer.querySelector(".notebook-viewer-tile").onclick = tileContextWindows
  viewer.querySelector(".notebook-viewer-pin").onclick = () => toggleWindowPin(viewer)
  viewer.querySelector(".notebook-viewer-persist").onclick = () => toggleWindowPersist(viewer)
  viewer.querySelector(".notebook-viewer-ai").onclick = () => generateNotebookSummary(viewer)
  viewer.querySelector(".notebook-viewer-rename").onclick = () => startNotebookRename(viewer)
  const modeBtn = viewer.querySelector(".notebook-viewer-mode")
  modeBtn.addEventListener("mousedown", (event) => event.preventDefault())
  modeBtn.onclick = () => viewer.setNotebookEditing?.(!viewer.editing)
  const colorEl = viewer.querySelector(".notebook-viewer-color")
  colorEl.value = notebookIconColor(state.nodesById.get(viewer.dataset.nodeId))
  colorEl.addEventListener("input", () => {
    const node = state.nodesById.get(viewer.dataset.nodeId)
    if (node) node.meta = { ...node.meta, iconColor: colorEl.value }
    draw()
  })
  colorEl.addEventListener("change", async () => {
    try {
      await api(`/nodes/${viewer.dataset.nodeId}`, { method: "PATCH", body: JSON.stringify({ iconColor: colorEl.value }) })
      const node = state.nodesById.get(viewer.dataset.nodeId)
      if (node) node.meta = { ...node.meta, iconColor: colorEl.value }
      draw()
    } catch (error) {
      statusEl.textContent = "改色失败: " + error.message
    }
  })
  viewer.querySelector(".nb-summary-close").onclick = () => {
    viewer.summaryCollapsed = true
    viewer.querySelector(".nb-summary").hidden = true
    setSummaryCollapsed(viewer.dataset.nodeId, true)
  }
  viewer.querySelector(".notebook-viewer-max").onclick = () => toggleWindowMaximize(viewer)
  enablePathDrop(viewer, () => {
    viewer.setNotebookEditing?.(true)
    return viewer.querySelector(".nb-doc")
  })
  attachTitleBarDrag(viewer)
  attachWindowResize(viewer, {
    minWidth: 300,
    minHeight: 240,
    save: (w, h) => localStorage.setItem("nodex.notebookSize", JSON.stringify({ w, h })),
  })
  viewer.querySelector(".notebook-viewer-body").addEventListener("scroll", hideMdTooltip)
}

document.getElementById("zoomIn").onclick = () => {
  const { w, h } = viewport()
  zoomAt(w / 2, h / 2, 1.25)
  draw()
}
document.getElementById("zoomOut").onclick = () => {
  const { w, h } = viewport()
  zoomAt(w / 2, h / 2, 1 / 1.25)
  draw()
}
document.getElementById("fitView").onclick = () => { fitView(); draw() }

// ---------------- 新建会话节点 ----------------
function childPosition(parentId) {
  const p = state.positions.get(parentId) ?? { x: 0, y: 0 }
  const distance = radiusOf(parentId) + 150
  const existing = state.graph.links.filter((link) => link.from === parentId || link.to === parentId).length
  const angle = -Math.PI / 2 + (existing % 8) * (Math.PI / 4)
  return { x: p.x + Math.cos(angle) * distance, y: p.y + Math.sin(angle) * distance }
}

async function createNodeAt(position, { fromId = null, name = "" } = {}) {
  statusEl.textContent = "正在新建节点…"
  try {
    const created = await api("/nodes", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: state.activeWs,
        model: currentModel(),
        title: name,
        inheritFromNodeId: fromId && state.nodesById.has(fromId) ? fromId : undefined,
      }),
      timeout: 30000,
    })
    if (position) {
      state.positions.set(created.id, { ...position })
      state.anchors.set(created.id, { ...position })
      state.pinned.add(created.id)
      savedPositions.set(created.id, { ...position })
      savePinnedPositions()
    }
    if (fromId && state.nodesById.has(fromId)) {
      await api("/links", { method: "POST", body: JSON.stringify({ from: fromId, to: created.id, kind: "reference", directed: true }) })
    }
    await refresh()
    const viewer = await openContextViewer(created.id)
    viewer.querySelector(".context-prompt").focus()
    statusEl.textContent = ""
  } catch (error) {
    statusEl.textContent = `新建节点失败: ${error.message}`
  }
}

async function createConversationNode(position = null) {
  const button = document.getElementById("addNode")
  if (button.disabled) return
  button.disabled = true
  statusEl.textContent = "正在新建会话…"
  let created = null
  try {
    created = await api("/nodes", {
      method: "POST", body: JSON.stringify({ workspaceId: state.activeWs, model: currentModel() }), timeout: 30000,
    })
    if (position) {
      state.positions.set(created.id, { ...position })
      state.anchors.set(created.id, { ...position })
      state.pinned.add(created.id)
      savedPositions.set(created.id, { ...position })
      savePinnedPositions()
    }
    await refresh()
    const viewer = await openContextViewer(created.id)
    viewer.querySelector(".context-prompt").focus()
  } catch (error) {
    statusEl.textContent = created
      ? `会话已创建，但打开失败: ${error.message}。请刷新页面查看`
      : `新建失败: ${error.message}`
  } finally {
    button.disabled = false
  }
}

document.getElementById("addNode").onclick = () => createConversationNode()

// ---------------- 工作区（画布）面板 ----------------
const wsPanel = document.getElementById("wsPanel")
const wsListEl = document.getElementById("wsList")
const wsMsg = document.getElementById("wsMsg")

function setWsMsg(text, isError = false) {
  wsMsg.textContent = text
  wsMsg.className = "msg" + (isError ? " error" : "")
}

function openWsPanel() {
  renderWsPanel()
  const colorInput = document.getElementById("wsNewColor")
  colorInput.dataset.auto = "true"
  colorInput.value = nextWorkspaceColor()
  wsPanel.classList.add("open")
}

function closeWsPanel() {
  wsPanel.classList.remove("open")
}

// ---------------- AI 设置 ----------------
const aiPanel = document.getElementById("aiPanel")
const aiMsg = document.getElementById("aiMsg")

function setAiMsg(text, isError = false) {
  aiMsg.textContent = text
  aiMsg.className = "msg" + (isError ? " error" : "")
}

async function openAiPanel() {
  aiPanel.classList.add("open")
  setAiMsg("")
  document.getElementById("aiApiKey").value = ""
  try {
    const [info, settings] = await Promise.all([api("/settings/ai"), api("/settings")])
    document.getElementById("aiModel").value = info.model ?? ""
    document.getElementById("aiBaseUrl").value = info.baseUrl ?? ""
    document.getElementById("aiModel").placeholder = info.defaults?.model ?? "gpt-4o-mini"
    document.getElementById("aiBaseUrl").placeholder = info.defaults?.baseUrl ?? ""
    document.getElementById("contextLimit").value = Math.round((settings.contextLimit ?? 300000) / 1000)
    document.getElementById("autoCompact").checked = settings.autoCompact === true
    const sourceText = { settings: "来自 AI 设置", env: "来自环境变量", opencode: "来自 OpenCode 配置", none: "未配置" }[info.apiKeySource] ?? ""
    document.getElementById("aiKeyState").textContent = info.hasApiKey
      ? `当前 Key：${info.apiKeyMasked}（${sourceText}）· 生效模型 ${info.effectiveModel}`
      : "当前未配置 API Key，请填写后保存"
  } catch (error) {
    setAiMsg("读取设置失败: " + error.message, true)
  }
}

function closeAiPanel() { aiPanel.classList.remove("open") }

async function saveAiSettings() {
  const body = {
    model: document.getElementById("aiModel").value.trim(),
    baseUrl: document.getElementById("aiBaseUrl").value.trim(),
  }
  const key = document.getElementById("aiApiKey").value.trim()
  if (key) body.apiKey = key
  try {
    await api("/settings/ai", { method: "PUT", body: JSON.stringify(body) })
    const limitK = Number(document.getElementById("contextLimit").value)
    const autoCompact = document.getElementById("autoCompact").checked
    const settingsBody = { autoCompact }
    if (Number.isFinite(limitK) && limitK > 0) settingsBody.contextLimit = Math.round(limitK * 1000)
    const saved = await api("/settings", { method: "PUT", body: JSON.stringify(settingsBody) })
    state.contextLimit = saved.contextLimit ?? state.contextLimit
    state.autoCompact = saved.autoCompact === true
    for (const viewer of contextWindows.values()) renderContextUsage(viewer)
    await openAiPanel()
    setAiMsg("已保存")
  } catch (error) {
    setAiMsg("保存失败: " + error.message, true)
  }
}

async function testAiSettings() {
  setAiMsg("测试中…")
  try {
    const result = await api("/settings/ai/test", { method: "POST", body: "{}", timeout: 40000 })
    setAiMsg(`连接正常 · ${result.model}：${result.reply}`)
  } catch (error) {
    setAiMsg("连接失败: " + error.message, true)
  }
}

async function clearAiKey() {
  try {
    await api("/settings/ai", { method: "PUT", body: JSON.stringify({ clearApiKey: true }) })
    await openAiPanel()
    setAiMsg("已清除本地 Key，将回退到 OpenCode 配置")
  } catch (error) {
    setAiMsg("清除失败: " + error.message, true)
  }
}

function renderWsPanel() {
  const { workspaces, members } = state.graph
  wsListEl.innerHTML = workspaces.length
    ? workspaces
        .map((w) => {
          const count = members.filter((m) => m.workspaceId === w.id).length
          const active = state.activeWs === w.id
          return `<div class="ws-row" data-ws="${escapeHtml(w.id)}">
            <span class="ws-dot" style="background:${escapeHtml(w.color || "#6366f1")}"></span>
            <span class="ws-name" title="${escapeHtml(w.name)}">${escapeHtml(w.name)}</span>
            <span class="muted">${count} 节点</span>
            <div class="ws-actions">
              <button data-open="${escapeHtml(w.id)}" ${active ? 'class="primary"' : ""} title="切换到此页面">${active ? "当前" : "打开"}</button>
              <button data-dir="${escapeHtml(w.id)}" title="设置此页面的工作区目录">目录</button>
              <button data-rename="${escapeHtml(w.id)}" title="重命名">改名</button>
              <button data-del class="danger" data-wsdel="${escapeHtml(w.id)}" title="删除页面（节点保留）">删除</button>
            </div>
          </div>`
        })
        .join("")
    : '<span class="muted">还没有页面，新建一个吧</span>'

  wsListEl.querySelectorAll("[data-open]").forEach((el) => {
    el.onclick = () => switchPage(el.dataset.open)
  })
  wsListEl.querySelectorAll("[data-rename]").forEach((el) => {
    el.onclick = () => renameWorkspace(el.dataset.rename)
  })
  wsListEl.querySelectorAll("[data-dir]").forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.dir
      if (state.activeWs !== id) switchPage(id)
      openFsPanel()
      setFsMode("global")
      setTimeout(() => fsDirInput?.focus(), 0)
    }
  })
  wsListEl.querySelectorAll("[data-wsdel]").forEach((el) => {
    el.onclick = () => deleteWorkspace(el.dataset.wsdel)
  })

  const opts = workspaces
    .map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`)
    .join("")
  const from = document.getElementById("wsMergeFrom")
  const into = document.getElementById("wsMergeInto")
  from.innerHTML = opts
  into.innerHTML = opts
  if (workspaces.length > 1) into.selectedIndex = 1
}

// ---------------- 多 agent 协作模板 ----------------
const templatePanel = document.getElementById("templatePanel")
const templateList = document.getElementById("templateList")
const tplMsg = document.getElementById("tplMsg")

function setTplMsg(text, isError = false) {
  tplMsg.textContent = text
  tplMsg.className = "msg" + (isError ? " error" : "")
}

async function loadTemplates() {
  const [templates, collaborations] = await Promise.all([api("/templates"), api("/collaborations")])
  state.templates = templates.templates ?? []
  state.collaborations = collaborations.collaborations ?? []
  renderTemplatePanel()
  renderCollaborations()
}

function openTemplatePanel() {
  loadTemplates().catch((error) => setTplMsg(error.message, true))
  renderCollabConfig()
  templatePanel.classList.add("open")
}

function closeTemplatePanel() {
  templatePanel.classList.remove("open")
}

function renderTemplatePanel() {
  templateList.innerHTML = state.templates.length
    ? state.templates
        .filter((template) => !template.builtin)
        .map((template) => `<div class="template-row">
          <div>
            <div class="template-name">${escapeHtml(template.name)}${template.builtin ? ' <span class="badge">内置</span>' : ""}</div>
            <div class="template-desc">${escapeHtml(template.description || `${template.slots.length} 个 agent · ${template.links.length} 条连接`)}</div>
          </div>
          <div class="template-actions">
            <button data-tplapply="${escapeHtml(template.id)}">应用</button>
            ${template.builtin ? "" : `<button data-tpldel="${escapeHtml(template.id)}" class="danger">删除</button>`}
          </div>
        </div>`)
        .join("")
    : '<span class="muted">还没有自定义布局</span>'
  templateList.querySelectorAll("[data-tplapply]").forEach((button) => {
    button.onclick = () => applyTemplate(button.dataset.tplapply)
  })
  templateList.querySelectorAll("[data-tpldel]").forEach((button) => {
    button.onclick = () => deleteTemplate(button.dataset.tpldel)
  })
}

const collabKind = document.getElementById("collabKind")
const collabConfig = document.getElementById("collabConfig")
const collabInstances = document.getElementById("collabInstances")
const collabMsg = document.getElementById("collabMsg")
const collabExisting = document.getElementById("collabExisting")

function collaborationConfig(kind, root) {
  const value = (key) => Number(root.querySelector(`[data-config="${key}"]`)?.value)
  if (kind === "three-ministries") {
    const layers = root.querySelector('[data-config="layers"]')?.value.split(",").map((item) => Number(item.trim()))
    return { layers }
  }
  if (kind === "brainstorm") return { agents: value("agents") }
  return { sides: value("sides"), perSide: value("perSide") }
}

function configFields(kind, config = {}) {
  if (kind === "three-ministries") return `<label>每层 agent 数量（2-5 层）<input data-config="layers" value="${escapeHtml((config.layers ?? [3, 6]).join(","))}" inputmode="text" /></label>`
  if (kind === "brainstorm") return `<label>子 agent 数量<input type="number" data-config="agents" min="1" max="12" value="${config.agents ?? 6}" /></label>`
  return `<label>辩论方数<input type="number" data-config="sides" min="2" max="6" value="${config.sides ?? 2}" /></label><label>每方辩手<input type="number" data-config="perSide" min="1" max="6" value="${config.perSide ?? 2}" /></label>`
}

function renderCollabConfig() {
  collabConfig.innerHTML = configFields(collabKind.value)
  const used = new Set(state.collaborations.flatMap((instance) => instance.slots.map((slot) => slot.nodeId)))
  const candidates = templateAgents().filter((node) => !used.has(node.id))
  collabExisting.innerHTML = candidates.map((node) => `<label class="tpl-slot"><input type="checkbox" value="${escapeHtml(node.id)}" />${escapeHtml(node.title)}</label>`).join("") || '<span class="muted">无可选会话，将创建空节点</span>'
  collabExisting.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.onchange = () => {
      if (checkbox.checked) checkbox.dataset.order = String(Date.now() + Math.random())
      else delete checkbox.dataset.order
    }
  })
}
collabKind.onchange = renderCollabConfig

function positionCollaboration(instance) {
  const all = instance.slots.map((slot) => slot.nodeId).filter(Boolean)
  const existing = all.map((id) => state.positions.get(id)).filter(Boolean)
  const offset = existing.length ? { x: existing[0].x, y: existing[0].y } : { x: state.camera.x, y: state.camera.y }
  const first = instance.slots[0] ?? { x: 0, y: 0 }
  for (const slot of instance.slots) {
    if (!slot.nodeId) continue
    const p = { x: offset.x + slot.x - first.x, y: offset.y + slot.y - first.y }
    state.positions.set(slot.nodeId, p)
    state.anchors.set(slot.nodeId, { ...p })
    state.pinned.add(slot.nodeId)
  }
  draw()
}

function renderCollaborations() {
  const list = state.collaborations.filter((item) => !state.activeWs || item.workspaceId === state.activeWs)
  collabInstances.innerHTML = list.map((item) => `
    <details class="tpl-instance" data-instance="${escapeHtml(item.id)}">
      <summary>${escapeHtml(item.name)} · ${item.slots.length} agent</summary>
      <div class="tpl-fields">${configFields(item.kind, item.config)}</div>
      <div class="row"><button data-preview="${escapeHtml(item.id)}">预览槽位</button></div>
      <div data-slots="${escapeHtml(item.id)}">
      <div class="section-title">槽位绑定（可替换；移除时已有对话保留）</div>
      ${item.slots.map((slot) => `<div class="tpl-slot-group"><label class="tpl-slot"><span title="${escapeHtml(slot.label)}">${escapeHtml(slot.label)}</span><select data-slot="${escapeHtml(slot.key)}"><option value="">新建空节点</option>${templateAgents().concat(item.slots.map((s) => state.nodesById.get(s.nodeId)).filter(Boolean)).filter((node, index, arr) => arr.findIndex((other) => other.id === node.id) === index).map((node) => `<option value="${escapeHtml(node.id)}" ${node.id === slot.nodeId ? "selected" : ""}>${escapeHtml(node.title)}</option>`).join("")}</select></label><input data-instruction="${escapeHtml(slot.key)}" value="${escapeHtml(item.instructions?.[slot.key] ?? "")}" placeholder="${escapeHtml(slot.label)}的执行要求（可选）" /></div>`).join("")}
      </div>
      <div class="row"><button data-update="${escapeHtml(item.id)}">更新结构与绑定</button><button data-focus="${escapeHtml(item.id)}">定位</button><button data-remove="${escapeHtml(item.id)}" class="danger">删除协作</button></div>
      <textarea data-task="${escapeHtml(item.id)}" placeholder="输入协作任务…"></textarea>
      <div class="row end"><button data-start="${escapeHtml(item.id)}" class="primary">启动协作</button></div>
    </details>`).join("") || '<div class="muted">当前页面尚无协作实例</div>'
  collabInstances.querySelectorAll("[data-update]").forEach((button) => button.onclick = () => updateCollaboration(button.dataset.update))
  collabInstances.querySelectorAll("[data-preview]").forEach((button) => button.onclick = () => previewCollaboration(button.dataset.preview))
  collabInstances.querySelectorAll("[data-start]").forEach((button) => button.onclick = () => startCollaboration(button.dataset.start))
  collabInstances.querySelectorAll("[data-focus]").forEach((button) => button.onclick = () => positionCollaboration(state.collaborations.find((item) => item.id === button.dataset.focus)))
  collabInstances.querySelectorAll("[data-remove]").forEach((button) => button.onclick = async () => {
    const instance = state.collaborations.find((item) => item.id === button.dataset.remove)
    if (!await confirmDanger("删除协作？", `删除协作「${instance.name}」？已有对话节点会保留。`, "删除协作")) return
    try {
      await api(`/collaborations/${instance.id}`, { method: "DELETE" })
      await refresh()
      await loadTemplates()
      collabMsg.textContent = "已删除协作"
    } catch (error) { collabMsg.textContent = error.message }
  })
}

async function previewCollaboration(id) {
  const item = state.collaborations.find((entry) => entry.id === id)
  const root = collabInstances.querySelector(`[data-instance="${id}"]`)
  const target = root.querySelector("[data-slots]")
  try {
    const config = collaborationConfig(item.kind, root)
    const sizes = item.kind === "three-ministries" ? config.layers : item.kind === "brainstorm" ? [config.agents] : [config.sides, config.perSide]
    if (!sizes.every((size) => Number.isInteger(size) && size >= 1 && size <= 12) ||
        (item.kind === "three-ministries" && (sizes.length < 2 || sizes.length > 5 || sizes.reduce((sum, size) => sum + size, 0) > 36)) ||
        (item.kind === "debate" && (config.sides < 2 || config.sides > 6 || config.perSide > 6))) throw new Error("人数超出模板范围")
    const labels = item.kind === "three-ministries"
      ? [{ key: "emperor", label: "皇帝" }, ...config.layers.flatMap((size, level) => Array.from({ length: size }, (_, index) => ({ key: `layer${level + 1}_${index + 1}`, label: `第${level + 1}层 ${index + 1}` })))]
      : item.kind === "brainstorm"
        ? [{ key: "center", label: "主持" }, ...Array.from({ length: config.agents }, (_, index) => ({ key: `idea${index + 1}`, label: `发散 ${index + 1}` }))]
        : [{ key: "moderator", label: "主持" }, ...Array.from({ length: config.sides }, (_, side) => Array.from({ length: config.perSide }, (_, index) => ({ key: `side${side + 1}_${index + 1}`, label: `第${side + 1}方 ${index + 1}辩` }))).flat(), { key: "judge", label: "评审" }]
    const existing = new Map([...target.querySelectorAll(".tpl-slot-group")].map((group) => [group.querySelector("[data-slot]").dataset.slot, group]))
    const candidates = [...new Map(templateAgents().concat(item.slots.map((slot) => state.nodesById.get(slot.nodeId)).filter(Boolean)).map((node) => [node.id, node])).values()]
    target.innerHTML = '<div class="section-title">槽位绑定（可替换；移除时已有对话保留）</div>' + labels.map((slot) => {
      const group = existing.get(slot.key)
      const nodeId = group?.querySelector("[data-slot]").value ?? ""
      const note = group?.querySelector("[data-instruction]").value ?? ""
      return `<div class="tpl-slot-group"><label class="tpl-slot"><span>${escapeHtml(item.slots.find((old) => old.key === slot.key)?.label ?? slot.label)}</span><select data-slot="${escapeHtml(slot.key)}"><option value="">新建空节点</option>${candidates.map((node) => `<option value="${escapeHtml(node.id)}" ${node.id === nodeId ? "selected" : ""}>${escapeHtml(node.title)}</option>`).join("")}</select></label><input data-instruction="${escapeHtml(slot.key)}" value="${escapeHtml(note)}" placeholder="执行要求（可选）" /></div>`
    }).join("")
  } catch (error) { collabMsg.textContent = error.message }
}

document.getElementById("collabCreate").onclick = async (event) => {
  const btn = event.currentTarget
  btn.disabled = true
  collabMsg.textContent = "创建会话中…"
  try {
    const selected = [...collabExisting.querySelectorAll("input:checked")].sort((a, b) => Number(a.dataset.order) - Number(b.dataset.order)).map((el) => el.value)
    const item = await api("/collaborations", { method: "POST", body: JSON.stringify({
      kind: collabKind.value, name: document.getElementById("collabName").value.trim(),
      config: collaborationConfig(collabKind.value, collabConfig), nodeIds: selected,
      workspaceId: state.activeWs || undefined,
    }) })
    await refresh()
    await loadTemplates()
    positionCollaboration(item)
    collabMsg.textContent = `已创建「${item.name}」，${item.slots.length} 个角色`
  } catch (error) { collabMsg.textContent = error.message }
  finally { btn.disabled = false }
}

async function updateCollaboration(id) {
  const item = state.collaborations.find((entry) => entry.id === id)
  const root = collabInstances.querySelector(`[data-instance="${id}"]`)
  const btn = root.querySelector("[data-update]")
  btn.disabled = true
  try {
    const bindings = Object.fromEntries([...root.querySelectorAll("[data-slot]")].map((el) => [el.dataset.slot, el.value || null]))
    const instructions = Object.fromEntries([...root.querySelectorAll("[data-instruction]")].map((el) => [el.dataset.instruction, el.value]))
    const updated = await api(`/collaborations/${id}`, { method: "PUT", body: JSON.stringify({ config: collaborationConfig(item.kind, root), bindings, instructions }) })
    await refresh()
    await loadTemplates()
    positionCollaboration(updated)
    collabMsg.textContent = "结构与绑定已更新"
  } catch (error) { collabMsg.textContent = error.message }
  finally { btn.disabled = false }
}

async function startCollaboration(id) {
  const item = state.collaborations.find((entry) => entry.id === id)
  const root = collabInstances.querySelector(`[data-instance="${id}"]`)
  const task = root.querySelector("[data-task]").value.trim()
  if (!task) { collabMsg.textContent = "请填写协作任务"; return }
  const btn = root.querySelector("[data-start]")
  btn.disabled = true
  collabMsg.textContent = "协作运行中…"
  try {
    const result = await api(`/collaborations/${id}/start`, { method: "POST", body: JSON.stringify({ task, model: currentModel() }), timeout: 900000 })
    collabMsg.textContent = `已完成：${result.results.length} 个子 agent，主节点已汇总`
    await refresh()
    const alreadyOpen = contextWindows.has(result.mainNodeId)
    await openContextViewer(result.mainNodeId)
    if (alreadyOpen) await reloadContextViewer(result.mainNodeId)
  } catch (error) { collabMsg.textContent = error.message }
  finally { btn.disabled = false; draw() }
}

function templateAgents() {
  return visibleNodes().filter((node) => node.kind === "session")
}

async function applyTemplate(templateId) {
  const template = state.templates.find((item) => item.id === templateId)
  if (!template) return
  const agents = templateAgents()
  if (!agents.length) {
    setTplMsg("当前页面没有 agent 会话节点", true)
    return
  }
  const byId = new Map(agents.map((node) => [node.id, node]))
  const used = new Set()
  const slotNodes = new Map()
  let cursor = 0
  for (const slot of template.slots) {
    let node = slot.nodeId ? byId.get(slot.nodeId) : null
    while (!node && cursor < agents.length) {
      const candidate = agents[cursor++]
      if (!used.has(candidate.id)) node = candidate
    }
    if (!node) continue
    used.add(node.id)
    slotNodes.set(slot.key, node)
    state.positions.set(node.id, { x: slot.x, y: slot.y })
    state.anchors.set(node.id, { x: slot.x, y: slot.y })
    state.pinned.add(node.id)
  }

  let created = 0
  for (const spec of template.links) {
    const from = slotNodes.get(spec.from)
    const to = slotNodes.get(spec.to)
    if (!from || !to || from.id === to.id) continue
    const exists = state.graph.links.some(
      (link) => (link.from === from.id && link.to === to.id) || (!link.directed && link.from === to.id && link.to === from.id),
    )
    if (exists) continue
    await api("/links", {
      method: "POST",
      body: JSON.stringify({ from: from.id, to: to.id, kind: spec.kind ?? "reference", directed: spec.directed !== false }),
    })
    created += 1
  }
  await refresh()
  state.needFit = true
  fitView()
  draw()
  setTplMsg(`已应用「${template.name}」：定位 ${slotNodes.size} 个 agent${created ? `，新建 ${created} 条连接` : ""}`)
}

async function saveCurrentTemplate() {
  const nameEl = document.getElementById("tplName")
  const descriptionEl = document.getElementById("tplDescription")
  const name = nameEl.value.trim()
  const agents = templateAgents()
  if (!name) {
    setTplMsg("请输入模板名称", true)
    return
  }
  if (!agents.length) {
    setTplMsg("当前页面没有 agent 会话节点", true)
    return
  }
  const slotOf = new Map()
  const slots = agents.map((node, index) => {
    const key = `agent_${index + 1}`
    slotOf.set(node.id, key)
    const pos = state.positions.get(node.id) ?? { x: index * 120, y: 0 }
    return { key, label: node.title, nodeId: node.id, x: pos.x, y: pos.y }
  })
  const links = state.graph.links
    .filter((link) => slotOf.has(link.from) && slotOf.has(link.to))
    .map((link) => ({ from: slotOf.get(link.from), to: slotOf.get(link.to), kind: link.kind, directed: link.directed }))
  try {
    await api("/templates", {
      method: "POST",
      body: JSON.stringify({ name, description: descriptionEl.value.trim(), slots, links }),
    })
    nameEl.value = ""
    descriptionEl.value = ""
    await loadTemplates()
    setTplMsg(`已保存「${name}」`)
  } catch (error) {
    setTplMsg(error.message, true)
  }
}

async function deleteTemplate(id) {
  const template = state.templates.find((item) => item.id === id)
  if (!template || !await confirmDanger("删除模板？", `删除模板「${template.name}」？此操作无法撤销。`, "删除模板")) return
  try {
    await api(`/templates/${id}`, { method: "DELETE" })
    await loadTemplates()
    setTplMsg("已删除模板")
  } catch (error) {
    setTplMsg(error.message, true)
  }
}

// ---------------- 标题栏按钮：右键管理（排序 / 隐藏 / 恢复默认） ----------------
const TITLE_BUTTON_KEY = "nodex.titleButtons"
const titleBtnMenu = document.getElementById("titleBtnMenu")
const titleBtnEditBar = document.getElementById("titleBtnEditBar")
const titleBtnEditHint = document.getElementById("titleBtnEditHint")
let titleBtnConfig = loadTitleButtonConfig()
let titleEditMode = null

function loadTitleButtonConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(TITLE_BUTTON_KEY) || "{}")
    return { order: Array.isArray(c.order) ? c.order : [], hidden: Array.isArray(c.hidden) ? c.hidden : [] }
  } catch { return { order: [], hidden: [] } }
}
function saveTitleButtonConfig() {
  try { localStorage.setItem(TITLE_BUTTON_KEY, JSON.stringify(titleBtnConfig)) } catch { /* Ignore blocked storage. */ }
}

function titleButtonKey(el) {
  if (el.classList.contains("context-export-toggle")) return "export"
  for (const cls of el.classList) {
    const m = cls.match(/^(?:context|notebook|file)-viewer-(.+)$/)
    if (m && !["title", "title-block", "title-line", "pages", "times", "body", "color"].includes(m[1])) return m[1]
  }
  if (el.classList.contains("notebook-viewer-color")) return "color"
  return null
}

function titleButtonsOf(bar) {
  const list = [...bar.children].filter((el) => el.matches("button, input[type=color]"))
  // 标题块里的重命名 / 颜色控件也是标题栏按钮，纳入「隐藏」管理，但不参与排序。
  for (const el of bar.querySelectorAll(".context-viewer-rename, .notebook-viewer-rename, .notebook-viewer-color")) {
    if (!list.includes(el)) list.push(el)
  }
  return list
}

/** 可排序的按钮：仅标题栏直接子元素，避免把重命名按钮移出标题块。 */
function orderableTitleButtonsOf(bar) {
  return [...bar.children].filter((el) => el.matches("button, input[type=color]"))
}

function applyTitleButtonConfig(viewer) {
  const bar = viewer.querySelector(".inspector-bar")
  if (!bar) return
  const buttons = titleButtonsOf(bar)
  for (const el of buttons) {
    const key = titleButtonKey(el)
    el.dataset.tbKey = key || ""
    if (titleEditMode) continue
    el.hidden = Boolean(key && titleBtnConfig.hidden.includes(key))
  }
  if (!titleEditMode && titleBtnConfig.order.length) {
    const ordered = orderableTitleButtonsOf(bar).sort((a, b) => {
      const ia = titleBtnConfig.order.indexOf(a.dataset.tbKey)
      const ib = titleBtnConfig.order.indexOf(b.dataset.tbKey)
      return (ia < 0 ? 9999 : ia) - (ib < 0 ? 9999 : ib)
    })
    for (const el of ordered) bar.append(el)
  }
}

function applyTitleButtonConfigAll() {
  for (const viewer of managedWindows()) {
    applyTitleButtonConfig(viewer)
    if (viewer.classList.contains("tile-docked")) applyDockTitleButtons(viewer, true)
  }
}

function openTitleBtnMenu(event, button) {
  const key = titleButtonKey(button)
  titleBtnMenu.dataset.key = key || ""
  titleBtnMenu.hidden = false
  titleBtnMenu.style.left = clamp(event.clientX, 8, window.innerWidth - 220) + "px"
  titleBtnMenu.style.top = clamp(event.clientY, 8, window.innerHeight - 180) + "px"
}
function hideTitleBtnMenu() { titleBtnMenu.hidden = true }

function showTitleEditBar(hint) {
  titleBtnEditHint.textContent = hint
  titleBtnEditBar.hidden = false
}
function hideTitleEditBar() { titleBtnEditBar.hidden = true }

function setTitleEditClasses() {
  const on = Boolean(titleEditMode)
  for (const viewer of managedWindows()) {
    const bar = viewer.querySelector(".inspector-bar")
    if (!bar) continue
    for (const el of titleButtonsOf(bar)) {
      el.classList.toggle("tb-selectable", titleEditMode === "hide")
      el.classList.toggle("tb-orderable", titleEditMode === "order")
      if (!on) { el.classList.remove("tb-marked", "tb-dragging"); el.draggable = false }
    }
  }
}

function titleEditClickGuard(event) {
  if (!titleEditMode) return
  const btn = event.target.closest(".inspector-bar button, .inspector-bar input[type=color]")
  if (!btn) return
  event.preventDefault()
  event.stopPropagation()
  if (titleEditMode === "hide") btn.classList.toggle("tb-marked")
}

function titleDragStart(event) {
  if (titleEditMode !== "order") return
  const el = event.target.closest(".inspector-bar button, .inspector-bar input[type=color]")
  if (!el) return
  event.dataTransfer.setData("text/plain", el.dataset.tbKey || "")
  event.dataTransfer.effectAllowed = "move"
  el.classList.add("tb-dragging")
}
function titleDragOver(event) {
  if (titleEditMode !== "order") return
  if (!event.target.closest(".inspector-bar button, .inspector-bar input[type=color]")) return
  event.preventDefault()
}
function titleDrop(event) {
  if (titleEditMode !== "order") return
  const target = event.target.closest(".inspector-bar button, .inspector-bar input[type=color]")
  if (!target) return
  const bar = target.closest(".inspector-bar")
  // 只允许在标题栏直接子按钮之间排序，避免把按钮拖进标题块。
  if (target.parentElement !== bar) return
  event.preventDefault()
  const draggedKey = event.dataTransfer.getData("text/plain")
  const dragged = [...bar.children].find((el) => el.dataset.tbKey === draggedKey)
  if (!dragged || dragged === target) return
  const rect = target.getBoundingClientRect()
  const after = event.clientX > rect.left + rect.width / 2
  target.insertAdjacentElement(after ? "afterend" : "beforebegin", dragged)
  const keys = orderableTitleButtonsOf(bar).map((el) => el.dataset.tbKey).filter(Boolean)
  for (const key of collectAllTitleKeys()) if (!keys.includes(key)) keys.push(key)
  titleBtnConfig.order = keys
  saveTitleButtonConfig()
}
function titleDragEnd(event) {
  const el = event.target.closest(".inspector-bar button, .inspector-bar input[type=color]")
  el?.classList.remove("tb-dragging")
}

function collectAllTitleKeys() {
  const keys = []
  for (const viewer of managedWindows()) {
    const bar = viewer.querySelector(".inspector-bar")
    if (!bar) continue
    for (const el of titleButtonsOf(bar)) {
      const key = el.dataset.tbKey || titleButtonKey(el)
      if (key && !keys.includes(key)) keys.push(key)
    }
  }
  return keys
}

function startTitleEditMode(mode) {
  titleEditMode = mode
  hideTitleBtnMenu()
  applyTitleButtonConfigAll()
  setTitleEditClasses()
  document.addEventListener("click", titleEditClickGuard, true)
  if (mode === "order") {
    for (const viewer of managedWindows()) {
      const bar = viewer.querySelector(".inspector-bar")
      if (!bar) continue
      for (const el of orderableTitleButtonsOf(bar)) {
        el.draggable = true
        el.addEventListener("dragstart", titleDragStart)
        el.addEventListener("dragover", titleDragOver)
        el.addEventListener("drop", titleDrop)
        el.addEventListener("dragend", titleDragEnd)
      }
    }
    showTitleEditBar("拖动标题栏按钮调整顺序，完成后生效")
  } else {
    showTitleEditBar("点击要隐藏的按钮（红色标记），完成后生效")
  }
}

function cleanupTitleEditMode() {
  document.removeEventListener("click", titleEditClickGuard, true)
  for (const viewer of managedWindows()) {
    const bar = viewer.querySelector(".inspector-bar")
    if (!bar) continue
    for (const el of titleButtonsOf(bar)) {
      el.removeEventListener("dragstart", titleDragStart)
      el.removeEventListener("dragover", titleDragOver)
      el.removeEventListener("drop", titleDrop)
      el.removeEventListener("dragend", titleDragEnd)
    }
  }
  titleEditMode = null
  hideTitleEditBar()
}

function finishTitleEditMode(commit) {
  if (!titleEditMode) return
  const mode = titleEditMode
  if (commit) {
    if (mode === "hide") {
      const marked = []
      for (const viewer of managedWindows()) {
        const bar = viewer.querySelector(".inspector-bar")
        if (!bar) continue
        for (const el of titleButtonsOf(bar)) if (el.classList.contains("tb-marked") && el.dataset.tbKey) marked.push(el.dataset.tbKey)
      }
      titleBtnConfig.hidden = [...new Set([...titleBtnConfig.hidden, ...marked])]
      saveTitleButtonConfig()
    } else if (mode === "order") {
      saveTitleButtonConfig()
    }
  }
  cleanupTitleEditMode()
  applyTitleButtonConfigAll()
  setTitleEditClasses()
}

document.addEventListener("contextmenu", (event) => {
  const button = event.target.closest(".inspector-bar button, .inspector-bar input[type=color]")
  if (button && !titleEditMode) {
    event.preventDefault()
    openTitleBtnMenu(event, button)
    return
  }
  // 统一屏蔽浏览器右键菜单（自定义菜单由各自监听处理）；输入区保留原生菜单便于粘贴。
  if (!event.target.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) {
    event.preventDefault()
  }
})
document.addEventListener("click", (event) => {
  if (!titleBtnMenu.hidden && !titleBtnMenu.contains(event.target)) hideTitleBtnMenu()
})
titleBtnMenu.querySelector("#tbMenuHideOne").onclick = () => {
  const key = titleBtnMenu.dataset.key
  hideTitleBtnMenu()
  if (!key) return
  titleBtnConfig.hidden = [...new Set([...titleBtnConfig.hidden, key])]
  saveTitleButtonConfig()
  applyTitleButtonConfigAll()
}
titleBtnMenu.querySelector("#tbMenuHideMulti").onclick = () => startTitleEditMode("hide")
titleBtnMenu.querySelector("#tbMenuOrder").onclick = () => startTitleEditMode("order")
titleBtnMenu.querySelector("#tbMenuReset").onclick = () => {
  hideTitleBtnMenu()
  titleBtnConfig = { order: [], hidden: [] }
  saveTitleButtonConfig()
  applyTitleButtonConfigAll()
  statusEl.textContent = "已恢复默认标题栏按钮布局"
}
titleBtnEditBar.querySelector("#titleBtnEditDone").onclick = () => finishTitleEditMode(true)
titleBtnEditBar.querySelector("#titleBtnEditCancel").onclick = () => finishTitleEditMode(false)

// ---------------- 页面切换与标签栏 ----------------
const tabsEl = document.getElementById("tabs")

function switchPage(wsId) {
  saveCameraForPage(state.activeWs)
  clearRegion()
  state.activeWs = wsId || null
  state.displayTitles = computeDisplayTitles()
  for (const [id, viewer] of contextWindows) renderContextViewerHeading(viewer, state.nodesById.get(id))
  for (const [id, viewer] of notebookWindows) renderNotebookTitle(viewer, state.nodesById.get(id))
  state.ghosts = []
  state.hoverGhost = null
  state.hoverNode = null
  state.hoverPosition = null
  nodeHoverInfo.classList.remove("open")
  state.selection = null
  hidePanel()
  closeLinkMenu()
  if (!restoreCameraForPage(state.activeWs)) fitView()
  applyWindowVisibility()
  if (tiledWindowPositions) retileContextWindows()
  saveWindowSessionSoon()
  draw()
  renderTabs()
  renderWsPanel()
  // 文件面板按页面显示工作区目录；切页后立即同步，避免沿用上一页的目录输入 / 树。
  if (!fsPanel.hidden) void reloadFsTree()
  if (templatePanel.classList.contains("open")) {
    renderCollabConfig()
    renderCollaborations()
  }
  if (wsId) {
    const ws = state.graph.workspaces.find((w) => w.id === wsId)
    statusEl.textContent = `页面「${ws?.name ?? wsId}」· ${nodesOfPage(wsId).length} 节点`
  }
}

function renderTabs() {
  const all = `<button class="tab ${state.activeWs ? "" : "active"}" data-tab="">全部</button>`
  const tabs = state.graph.workspaces
    .map((w) => {
      const n = nodesOfPage(w.id).length
      return `<button class="tab ${state.activeWs === w.id ? "active" : ""}" data-tab="${escapeHtml(w.id)}" title="${escapeHtml(w.name)}">
        <span class="tab-dot" style="background:${escapeHtml(w.color || "#6366f1")}"></span>
        <span class="tab-name">${escapeHtml(w.name)}</span>
        <span class="tab-count">${n}</span>
        <span class="tab-x" data-tabdel="${escapeHtml(w.id)}" title="删除页面">×</span>
      </button>`
    })
    .join("")
  tabsEl.querySelector("#tabItems").innerHTML = all + tabs
  tabsEl.querySelectorAll("[data-tab]").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.dataset.tabdel) return
      switchPage(el.dataset.tab)
    }
    el.ondblclick = (e) => {
      if (e.target.dataset.tabdel || !el.dataset.tab) return
      renameWorkspace(el.dataset.tab)
    }
  })
  tabsEl.querySelectorAll("[data-tabdel]").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation()
      deleteWorkspace(el.dataset.tabdel)
    }
  })
}

// 新建页面时优先选择与已有颜色差异较大的色系，并在该色系内做轻微随机，
// 避免多个页面颜色相近、难以区分。
const WORKSPACE_BASE_HUES = [232, 262, 200, 160, 96, 42, 18, 330, 300, 180]
function hexToHue(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim())
  if (!m) return null
  const value = parseInt(m[1], 16)
  const r = ((value >> 16) & 255) / 255, g = ((value >> 8) & 255) / 255, b = (value & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  if (d === 0) return null
  let hue
  if (max === r) hue = ((g - b) / d) % 6
  else if (max === g) hue = (b - r) / d + 2
  else hue = (r - g) / d + 4
  return (hue * 60 + 360) % 360
}
function hueDistance(a, b) {
  const diff = Math.abs(a - b) % 360
  return diff > 180 ? 360 - diff : diff
}
function hslToHex(h, s, l) {
  const sat = s / 100, light = l / 100
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = light - c / 2
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")
  return `#${to(r)}${to(g)}${to(b)}`
}
function nextWorkspaceColor() {
  const used = state.graph.workspaces.map((ws) => hexToHue(ws.color || "#6366f1")).filter((hue) => hue !== null)
  let best = WORKSPACE_BASE_HUES[0], bestGap = -1
  for (const hue of WORKSPACE_BASE_HUES) {
    const gap = used.length ? Math.min(...used.map((u) => hueDistance(hue, u))) : 360
    if (gap > bestGap) { bestGap = gap; best = hue }
  }
  const jitter = Math.round((Math.random() - 0.5) * 22)
  return hslToHex((best + jitter + 360) % 360, 62, 58)
}
function resolveWorkspaceColor() {
  const input = document.getElementById("wsNewColor")
  return input.dataset.auto === "false" ? input.value : nextWorkspaceColor()
}

async function createWorkspace({ auto = false } = {}) {
  const nameInput = document.getElementById("wsNewName")
  const name = nameInput.value.trim() || `页面 ${state.graph.workspaces.length + 1}`
  const color = auto ? nextWorkspaceColor() : resolveWorkspaceColor()
  const ws = await api("/workspaces", { method: "POST", body: JSON.stringify({ name, color }) })
  nameInput.value = ""
  const colorInput = document.getElementById("wsNewColor")
  if (colorInput.dataset.auto !== "false") colorInput.value = nextWorkspaceColor()
  await refresh()
  renderWsPanel()
  setWsMsg(`已创建页面「${ws.name}」`)
  switchPage(ws.id)
}

async function renameWorkspace(wsId) {
  const ws = state.graph.workspaces.find((w) => w.id === wsId)
  if (!ws) return
  const name = prompt("重命名工作区", ws.name)
  if (name === null || !name.trim()) return
  await api(`/workspaces/${wsId}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) })
  await refresh()
  renderWsPanel()
  setWsMsg("已重命名")
}

async function deleteWorkspace(wsId) {
  const ws = state.graph.workspaces.find((w) => w.id === wsId)
  if (!ws) return
  const count = state.graph.members.filter((m) => m.workspaceId === wsId).length
  if (!await confirmDanger("删除页面？", `删除页面「${ws.name}」？${count} 个节点只会移出该页面，不会被删除。`, "删除页面")) return
  await api(`/workspaces/${wsId}`, { method: "DELETE" })
  await refresh()
  renderWsPanel()
  setWsMsg("已删除工作区")
}

async function mergeWorkspaces() {
  const from = document.getElementById("wsMergeFrom").value
  const into = document.getElementById("wsMergeInto").value
  if (!from || !into) return
  if (from === into) {
    setWsMsg("不能合并到自身", true)
    return
  }
  const fromName = state.graph.workspaces.find((w) => w.id === from)?.name ?? from
  const intoName = state.graph.workspaces.find((w) => w.id === into)?.name ?? into
  if (!await confirmDanger("合并页面？", `把「${fromName}」的节点并进「${intoName}」，并删除「${fromName}」？`, "合并并删除源页面")) return
  try {
    await api(`/workspaces/${from}/merge`, { method: "POST", body: JSON.stringify({ into }) })
    await refresh()
    renderWsPanel()
    setWsMsg(`已合并「${fromName}」→「${intoName}」`)
  } catch (error) {
    setWsMsg(error.message, true)
  }
}

// ---------------- 搜索 ----------------
const searchInput = document.getElementById("search")
const searchResults = document.getElementById("searchResults")

function runSearch() {
  const q = searchInput.value.trim().toLowerCase()
  if (!q) {
    searchResults.classList.remove("open")
    searchResults.innerHTML = ""
    return
  }
  const hits = state.graph.nodes
    .filter((n) => {
      const pages = workspacesOfNode(n.id)
        .map((id) => state.graph.workspaces.find((w) => w.id === id)?.name ?? id)
      const hay = [n.title, ...(n.tags || []), ...pages].join(" ").toLowerCase()
      return hay.includes(q)
    })
    .slice(0, 12)

  if (!hits.length) {
    searchResults.innerHTML = '<span class="muted">没有匹配的节点</span>'
    searchResults.classList.add("open")
    return
  }

  searchResults.innerHTML = hits
    .map((n) => {
      const pages = workspacesOfNode(n.id)
        .map((id) => state.graph.workspaces.find((w) => w.id === id)?.name ?? id)
        .join(" · ")
      return `<button class="sr-item" data-goto="${escapeHtml(n.id)}">
        <div>${escapeHtml(nodeDisplayTitle(n.id))}</div>
        <div class="sr-sub">${escapeHtml(pages || "未加入页面")}</div>
      </button>`
    })
    .join("")
  searchResults.classList.add("open")
  searchResults.querySelectorAll("[data-goto]").forEach((el) => {
    el.onclick = () => gotoNode(el.dataset.goto)
  })
}

/** 跳转到某个节点：切到包含它的页面（优先非当前页），并选中、居中。 */
function gotoNode(nodeId) {
  const node = state.graph.nodes.find((n) => n.id === nodeId)
  if (!node) return
  const pages = workspacesOfNode(nodeId)
  state.activeWs = state.activeWs && pages.includes(state.activeWs) ? state.activeWs : pages[0] ?? null
  searchResults.classList.remove("open")
  searchInput.value = ""
  if (node.kind === "notebook") {
    openNodePanel(nodeId).catch((error) => (statusEl.textContent = error.message))
    renderTabs()
    draw()
    return
  }
  state.selection = { type: "node", id: nodeId }
  const p = state.positions.get(nodeId)
  if (p) {
    state.needFit = false
    state.camera = { zoom: Math.max(state.camera.zoom, 1), x: p.x, y: p.y }
  }
  select({ type: "node", id: nodeId })
  renderTabs()
}

searchInput.addEventListener("input", runSearch)
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    searchInput.value = ""
    searchResults.classList.remove("open")
    searchInput.blur()
  }
})
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) searchResults.classList.remove("open")
})

// 渲染后的 Markdown 链接：外链新开标签，绝对路径交给文件预览；任何情况下都不替换当前页面
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[href]")
  if (!link || link.hasAttribute("download")) return
  const href = link.getAttribute("href") || ""
  if (!href || href.startsWith("#")) return
  const path = href.replace(/^file:\/\//, "")
  if (!/^(https?:|mailto:|tel:)/i.test(href) && path.startsWith("/")) {
    event.preventDefault()
    event.stopPropagation()
    void openFileViewer(path)
    return
  }
  if (link.target === "_blank") return // 让浏览器原生在新标签打开
  event.preventDefault()
  event.stopPropagation()
  const opened = window.open(href, "_blank", "noopener,noreferrer")
  if (!opened) statusEl.textContent = `无法自动打开链接（可能被拦截）：${href}`
}, true)

// 「+ 页面」像浏览器一样立即新建并切过去；「页面管理」打开改名/合并/删除
document.getElementById("tabAdd").onclick = () =>
  createWorkspace({ auto: true }).catch((e) => setWsMsg(e.message, true))
document.getElementById("addNotebook").onclick = () =>
  createNotebook().catch((e) => (statusEl.textContent = "新建笔记本失败: " + e.message))
document.getElementById("templateBtn").onclick = openTemplatePanel
document.getElementById("templatePanelClose").onclick = closeTemplatePanel
document.getElementById("tplSave").onclick = saveCurrentTemplate
document.getElementById("addWorkspace").onclick = openWsPanel
document.getElementById("fsBrowserBtn").onclick = () => {
  if (fsPanel.hidden) openFsPanel()
  else closeFsPanel()
}
document.getElementById("aiSettingsBtn").onclick = openAiPanel
document.getElementById("aiPanelClose").onclick = closeAiPanel
document.getElementById("aiSave").onclick = saveAiSettings
document.getElementById("aiTest").onclick = testAiSettings
document.getElementById("aiClearKey").onclick = clearAiKey
document.getElementById("toggleWindows").onclick = () => {
  if (windowsHidden) {
    restoreAllWindows()
    draw()
  } else {
    hideAllWindows()
    nodeHoverInfo.classList.remove("open")
  }
}
const tileModeSelect = document.getElementById("tileModeSelect")
if (tileModeSelect) {
  tileModeSelect.value = tileMode
  tileModeSelect.addEventListener("change", () => {
    tileMode = tileModeSelect.value
    if (tiledWindowPositions) retileContextWindows()
  })
}
document.getElementById("closeAllWindows").onclick = async () => {
  const count = managedWindows().length
  if (!count) {
    statusEl.textContent = "当前没有打开的窗口"
    return
  }
  const persistent = managedWindows().filter((viewer) => viewer.windowPersistent).length
  const { ok, alt } = await confirmAction({
    title: "关闭所有窗口",
    text: `将关闭当前打开的 ${count} 个窗口（会话、笔记本与文件预览）。此操作不会删除节点或对话；也可只保留 ${persistent} 个 📌 常驻窗口。`,
    action: "关闭全部",
    alt: "仅保留常驻窗口",
  })
  if (!ok && !alt) return
  const closed = await closeAllWindows({ keepPersistent: alt })
  statusEl.textContent = alt ? `已关闭 ${closed} 个普通窗口，保留 ${persistent} 个常驻窗口` : `已关闭 ${closed} 个窗口`
}
document.getElementById("wsPanelClose").onclick = closeWsPanel
document.getElementById("wsNewBtn").onclick = () => createWorkspace().catch((e) => setWsMsg(e.message, true))
document.getElementById("wsNewColor").addEventListener("input", (event) => { event.target.dataset.auto = "false" })
document.getElementById("wsMergeBtn").onclick = mergeWorkspaces
document.getElementById("wsNewName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") createWorkspace().catch((err) => setWsMsg(err.message, true))
})

document.getElementById("reset").onclick = async () => {
  pushLayoutHistory()
  clearRegion()
  savedPositions.clear()
  localStorage.setItem("nodex.pinnedPositions", "{}")
  persistLayoutsSoon(true)
  state.pinned.clear()
  state.positions.clear()
  state.anchors.clear()
  state.needFit = true
  await refresh()
}

/** 目标是否为文本输入区域（用于避免抢占浏览器原生的 Ctrl+A / Ctrl+Z）。 */
function isTextEntryTarget(el) {
  if (!(el instanceof Element)) return false
  if (el.isContentEditable) return true
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true
  if (el.tagName !== "INPUT") return false
  const type = (el.getAttribute("type") || "text").toLowerCase()
  return !["checkbox", "radio", "range", "color", "file", "button", "submit", "reset"].includes(type)
}

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.isComposing) {
    const key = e.key.toLowerCase()
    if (!isTextEntryTarget(e.target)) {
      if (key === "a" && !e.shiftKey) {
        e.preventDefault()
        selectAllVisibleNodes()
        return
      }
      if (key === "z" && !e.shiftKey) {
        e.preventDefault()
        statusEl.textContent = undoLayout() ? "已撤销上一步布局操作" : "没有可撤销的布局操作"
        return
      }
    }
  }
  if (e.key === "Escape" && !e.isComposing && e.keyCode !== 229) {
    if (deleteNodeDialog.open) return
    if (state.lassoArmed) { cancelLasso(); e.preventDefault(); return }
    if (!canvasMenu.hidden) { hideCanvasMenu(); e.preventDefault(); return }
    if (state.region) { clearRegion(); e.preventDefault(); return }
    const focusedViewer = e.target instanceof Element ? e.target.closest(".context-viewer") : null
    const viewer = focusedViewer && contextWindows.get(focusedViewer.dataset.nodeId) === focusedViewer
      ? focusedViewer : [...contextWindows.values()].sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0]
    const focusedFile = e.target instanceof Element ? e.target.closest(".file-viewer") : null
    const focusedFileViewer = focusedFile && fileWindows.get(focusedFile.dataset.path) === focusedFile ? focusedFile : null
    const topFileViewer = [...fileWindows.values()].sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0]
    if (focusedFileViewer) closeFileViewer(focusedFileViewer)
    else if (selMenu.classList.contains("open")) hideSelMenu()
    else if (focusedViewer && viewerIsRunning(focusedViewer)) {
      e.preventDefault()
      void interruptContextViewer(focusedViewer)
    } else if (viewer && viewerIsRunning(viewer)) {
      e.preventDefault()
      void interruptContextViewer(viewer)
    }     else if (viewer) closeContextViewer(viewer)
    else if (notebookWindows.size) closeNotebookViewer([...notebookWindows.values()].sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0])
    else if (topFileViewer) closeFileViewer(topFileViewer)
    else if (templatePanel.classList.contains("open")) closeTemplatePanel()
    else if (aiPanel.classList.contains("open")) closeAiPanel()
    else if (state.connect) cancelConnect()
    else if (state.selectedLink) select(null)
    else if (state.selection) select(null)
  }
})

window.addEventListener("resize", () => { resize(); if (tiledWindowPositions) retileContextWindows(); draw() })

// 拖动 / 缩放窗口后落盘窗口会话（含位置、置顶、常驻等状态）
window.addEventListener("pointerup", () => saveWindowSessionSoon())
window.addEventListener("beforeunload", () => { saveCameraForPage(); saveWindowSessionNow() })

resize()
loadModels()
loadAgents()
loadSettings()
loadCommands()
loadTemplates().catch(() => {})
refreshRuntimeStatus()
setInterval(refreshRuntimeStatus, 2000)
refresh().then(() => restoreWindowSession()).catch((error) => {
  statusEl.textContent = "连接失败: " + error.message
})
