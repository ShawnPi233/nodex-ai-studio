import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { RuntimeMessage } from "@nodex/runtime-opencode"

export type FileKind =
  | "html"
  | "markdown"
  | "json"
  | "jsonl"
  | "code"
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "text"
  | "binary"

/** 文件相对会话的方向：工具写入为输出，工具读取为输入。 */
export type FileDirection = "input" | "output" | "unknown"

export interface NodeFile {
  /** 绝对路径（用于预览与本地打开） */
  path: string
  /** 相对预览根目录的路径（便于展示） */
  rel: string
  name: string
  /** 产出该文件的工具名 */
  tool: string
  /** 该文件是会话的输入（读取）还是输出（写入） */
  direction: FileDirection
  exists: boolean
  size?: number
  kind: FileKind
}

export interface FileView extends NodeFile {
  mtime?: number
  language?: string
  mime: string
  encoding: "utf8" | "base64"
  content: string
  truncated?: boolean
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif"])
const AUDIO_EXT = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus"])
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".mkv"])
const ARCHIVE_EXT = new Set([
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".tbz2", ".xz", ".txz", ".7z", ".rar",
  ".war", ".jar", ".apk", ".dmg", ".iso", ".zst", ".lz4", ".cab", ".ar",
])
const CODE_EXT = new Set([
  ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".java", ".kt",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".sh", ".bash", ".zsh",
  ".sql", ".yml", ".yaml", ".toml", ".ini", ".css", ".scss", ".less", ".xml", ".vue", ".svelte",
])

/** 文本预览上限，避免把巨大文件整块塞进浏览器。 */
export const MAX_TEXT_BYTES = 512 * 1024

/** 二进制内联预览上限（base64 会再膨胀约 1/3），超过提示下载。 */
export const MAX_BINARY_BYTES = 24 * 1024 * 1024

export function classifyFile(path: string): FileKind {
  const ext = extname(path).toLowerCase()
  if (IMAGE_EXT.has(ext)) return "image"
  if (AUDIO_EXT.has(ext)) return "audio"
  if (VIDEO_EXT.has(ext)) return "video"
  if (ARCHIVE_EXT.has(ext)) return "archive"
  if (ext === ".html" || ext === ".htm") return "html"
  if (ext === ".md" || ext === ".markdown" || ext === ".mdx") return "markdown"
  if (ext === ".json") return "json"
  if (ext === ".jsonl" || ext === ".ndjson") return "jsonl"
  if (CODE_EXT.has(ext)) return "code"
  return "text"
}

const MIME: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".md": "text/markdown",
  ".json": "application/json", ".jsonl": "application/x-ndjson", ".ndjson": "application/x-ndjson",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".flac": "audio/flac", ".aac": "audio/aac", ".opus": "audio/opus",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".txt": "text/plain", ".log": "text/plain", ".csv": "text/csv",
  ".zip": "application/zip", ".tar": "application/x-tar", ".gz": "application/gzip",
  ".tgz": "application/gzip", ".7z": "application/x-7z-compressed", ".rar": "application/vnd.rar",
}

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream"
}

export function languageOf(path: string): string {
  const ext = extname(path).toLowerCase().replace(".", "")
  if (!ext) return "text"
  if (ext === "md") return "markdown"
  if (ext === "jsonl" || ext === "ndjson") return "json"
  if (ext === "py") return "python"
  if (ext === "ts" || ext === "tsx") return "typescript"
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return "javascript"
  return ext
}

export function isBinaryKind(kind: FileKind): boolean {
  return kind === "image" || kind === "audio" || kind === "video" || kind === "archive" || kind === "binary"
}

/**
 * 校验一个绝对路径是否落在允许预览的根目录内。
 * 使用 realpath 解析软链接，避免通过符号链接越界。
 */
export function isWithinRoot(path: string, root: string): boolean {
  let real: string
  let realRoot: string
  try {
    real = realpathSync(path)
  } catch {
    real = resolve(path)
  }
  try {
    realRoot = realpathSync(root)
  } catch {
    realRoot = resolve(root)
  }
  return real === realRoot || real.startsWith(realRoot + sep)
}

function toAbs(candidate: string, root: string): string {
  return isAbsolute(candidate) ? candidate : resolve(root, candidate)
}

const WRITE_HINTS = ["write", "edit", "patch", "create", "append", "save", "insert", "replace", "multiedit"]
const READ_HINTS = ["read", "glob", "grep", "list", "ls", "view", "cat", "find", "search", "fetch"]

/** 依据工具名判断文件是会话输入还是输出；无法判断返回 unknown。 */
export function directionOf(tool: string): FileDirection {
  const name = tool.toLowerCase()
  if (WRITE_HINTS.some((hint) => name.includes(hint))) return "output"
  if (READ_HINTS.some((hint) => name.includes(hint))) return "input"
  return "unknown"
}

function mergeDirection(a: FileDirection, b: FileDirection): FileDirection {
  if (a === "output" || b === "output") return "output"
  if (a === "input" || b === "input") return "input"
  return "unknown"
}

/**
 * 从会话消息里收集「被工具写入/读取过的文件」。
 * 只依赖 tool part 的 state.input / metadata 与 file part，
 * 不猜测不存在的文件；目录会被跳过。
 */
export function collectNodeFiles(
  messages: RuntimeMessage[],
  root: string,
): NodeFile[] {
  const found = new Map<string, { tool: string; direction: FileDirection }>()

  const note = (candidate: unknown, tool: string) => {
    if (typeof candidate !== "string" || !candidate.trim()) return
    const abs = toAbs(candidate.trim(), root)
    const direction = directionOf(tool)
    const prev = found.get(abs)
    if (prev) prev.direction = mergeDirection(prev.direction, direction)
    else found.set(abs, { tool, direction })
  }

  for (const m of messages) {
    for (const p of m.parts) {
      const st = (p.state ?? {}) as any
      const input = st.input ?? {}
      if (p.type === "tool") {
        note(input.filePath, p.tool ?? "tool")
        note(input.path, p.tool ?? "tool")
        note(input.file, p.tool ?? "tool")
        note(input.filename, p.tool ?? "tool")
        note(st.metadata?.filePath, p.tool ?? "tool")
        note(st.metadata?.path, p.tool ?? "tool")
      }
      if (p.type === "file" && p.filename) note(p.filename, "file")
    }
  }

  const files: NodeFile[] = []
  for (const [abs, { tool, direction }] of found) {
    let size: number | undefined
    let exists = false
    try {
      const s = statSync(abs)
      if (s.isDirectory()) continue
      exists = true
      size = s.size
    } catch {
      exists = false
    }
    files.push({
      path: abs,
      rel: relative(root, abs) || basename(abs),
      name: basename(abs),
      tool,
      direction,
      exists,
      size,
      kind: classifyFile(abs),
    })
  }
  files.sort((a, b) => Number(b.exists) - Number(a.exists) || a.rel.localeCompare(b.rel))
  return files
}

export interface DirEntry {
  name: string
  path: string
  rel: string
  type: "dir" | "file"
  size?: number
  mtime?: number
  kind?: FileKind
}

export interface DirListing {
  /** 当前目录的绝对路径 */
  path: string
  /** 相对根目录的路径（根为 "."） */
  rel: string
  /** 命中的允许根目录 */
  root: string
  entries: DirEntry[]
}

const MAX_DIR_ENTRIES = 4000

/**
 * 列出目录内容，用于本地目录浏览。
 * 路径必须落在 roots 之一内，否则拒绝；符号链接按 realpath 校验。
 */
export function listDirectory(dirPath: string, roots: string[]): DirListing | { error: string } {
  const abs = resolve(dirPath)
  const root = roots.find((candidate) => isWithinRoot(abs, candidate))
  if (!root) return { error: "路径超出允许浏览的根目录，已拒绝" }
  if (!existsSync(abs)) return { error: "目录不存在（可能已被删除）" }
  let st
  try {
    st = statSync(abs)
  } catch {
    return { error: "无法读取该路径" }
  }
  if (!st.isDirectory()) return { error: "该路径不是目录" }

  let dirents
  try {
    dirents = readdirSync(abs, { withFileTypes: true })
  } catch {
    return { error: "没有权限读取该目录" }
  }

  const entries: DirEntry[] = []
  for (const dirent of dirents.slice(0, MAX_DIR_ENTRIES)) {
    const child = resolve(abs, dirent.name)
    let size: number | undefined
    let mtime: number | undefined
    let isDir = dirent.isDirectory()
    try {
      const s = statSync(child)
      isDir = s.isDirectory()
      size = s.size
      mtime = s.mtimeMs
    } catch {
      /* 断链或权限不足：仍列出名称 */
    }
    entries.push({
      name: dirent.name,
      path: child,
      rel: relative(root, child) || dirent.name,
      type: isDir ? "dir" : "file",
      size: isDir ? undefined : size,
      mtime,
      kind: isDir ? undefined : classifyFile(child),
    })
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1))
  return { path: abs, rel: relative(root, abs) || ".", root, entries }
}

/** 读取文件用于预览；越界或不存在时返回错误说明。 */
export function readFileForPreview(path: string, root: string): FileView | { error: string } {
  const abs = toAbs(path, root)
  if (!existsSync(abs)) return { error: "文件不存在（可能已被删除或尚未生成）" }
  const rootAllowed = isWithinRoot(abs, root)
  if (!rootAllowed) {
    return { error: "路径超出允许预览的根目录，已拒绝读取（仅显示路径）" }
  }
  const st = statSync(abs)
  if (st.isDirectory()) return { error: "这是一个目录，无法预览" }

  const kind = classifyFile(abs)
  const mime = mimeOf(abs)
  const base = {
    path: abs,
    rel: relative(root, abs) || basename(abs),
    name: basename(abs),
    tool: "",
    exists: true,
    size: st.size,
    mtime: st.mtimeMs,
    kind,
    mime,
    language: languageOf(abs),
  }

  if (kind === "archive") {
    const ext = extname(abs).toLowerCase() || "压缩包"
    return { error: `${ext} 压缩包不支持预览（可复制路径本地打开或下载）` }
  }
  if (isBinaryKind(kind)) {
    if (st.size > MAX_BINARY_BYTES) {
      return { error: `文件较大（${Math.round(st.size / 1024 / 1024)}MB），超过内联预览上限，请下载或本地打开` }
    }
    return { ...base, encoding: "base64", content: readFileSync(abs).toString("base64") }
  }

  const buf = readFileSync(abs)
  // 未知扩展名的二进制（如 .pdf / .exe）按文本读取会得到乱码，这里用 NUL 字节粗判。
  if (buf.subarray(0, 8192).includes(0)) {
    return { error: "疑似二进制文件，无法预览（可复制路径本地打开或下载）" }
  }
  const truncated = buf.length > MAX_TEXT_BYTES
  const slice = truncated ? buf.subarray(0, MAX_TEXT_BYTES) : buf
  return { ...base, encoding: "utf8", content: slice.toString("utf8"), truncated }
}

/** 可编辑文本大小上限：超过则拒绝写入，避免误覆盖大文件。 */
export const MAX_EDIT_BYTES = 5 * 1024 * 1024

/**
 * 保存文本编辑内容：仅允许写回允许根内已存在的文本文件，
 * 拒绝二进制、目录、越界路径与超大内容。
 */
export function writeFileForEdit(path: string, content: unknown, roots: string[]): FsOpResult {
  if (typeof content !== "string") return { error: "内容必须是字符串" }
  const target = resolveWithinRoots(path, roots)
  if ("error" in target) return target
  if (!existsSync(target.abs)) return { error: "文件不存在（可能已被删除）" }
  const st = statSync(target.abs)
  if (st.isDirectory()) return { error: "这是一个目录，无法写入" }
  if (isBinaryKind(classifyFile(target.abs))) return { error: "二进制文件不支持在线编辑" }
  const bytes = Buffer.byteLength(content, "utf8")
  if (bytes > MAX_EDIT_BYTES) return { error: `内容过大（${Math.round(bytes / 1024)}KB），超过在线编辑上限` }
  try {
    writeFileSync(target.abs, content, "utf8")
  } catch (error) {
    return { error: `保存失败: ${(error as Error).message}` }
  }
  return { path: target.abs, name: basename(target.abs), size: bytes }
}

/** 读取文件原始字节，用于下载。 */
export function readRawFile(path: string, roots: string[]): { buffer: Buffer; name: string; mime: string } | { error: string } {
  const target = resolveWithinRoots(path, roots)
  if ("error" in target) return target
  if (!existsSync(target.abs)) return { error: "文件不存在" }
  const st = statSync(target.abs)
  if (st.isDirectory()) return { error: "这是一个目录，无法下载" }
  try {
    return { buffer: readFileSync(target.abs), name: basename(target.abs), mime: mimeOf(target.abs) }
  } catch (error) {
    return { error: `读取失败: ${(error as Error).message}` }
  }
}

// ---------------- 文件 / 目录写操作（目录树右键菜单） ----------------
export interface FsOpResult {
  path?: string
  name?: string
  from?: string
  to?: string
  trashPath?: string
  error?: string
  exists?: boolean
}

/** 解析路径并确认它落在某个允许根内。 */
export function resolveWithinRoots(path: string, roots: string[]): { abs: string; root: string } | { error: string } {
  const abs = resolve(path)
  const root = roots.find((candidate) => isWithinRoot(abs, candidate))
  if (!root) return { error: "路径超出允许操作的根目录，已拒绝" }
  return { abs, root: resolve(root) }
}

/** 校验单个文件 / 目录名（不允许路径分隔符与相对片段）。 */
function safeName(name: unknown): string | null {
  if (typeof name !== "string") return null
  const value = name.trim()
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) return null
  return value
}

function isRootItself(abs: string, root: string): boolean {
  return resolve(abs) === resolve(root)
}

/**
 * 跨设备移动：优先 rename；遇到 EXDEV（例如回收站在 /tmp 而文件在其它挂载点）
 * 退化为「复制 + 删除」，保证删除 / 移动 / 撤回都能工作。
 */
function moveSync(src: string, dest: string): void {
  try {
    renameSync(src, dest)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
  }
  cpSync(src, dest, { recursive: true, force: true, errorOnExist: false })
  rmSync(src, { recursive: true, force: true })
}

/**
 * 解析文件名里已有的 “ copy” / “ copy N” 后缀，返回去掉该后缀的主名与扩展名。
 * 这样重复复制 a.txt / a copy.txt 都会得到 a copy.txt → a copy 2.txt → a copy 3.txt，
 * 与 VS Code 的粘贴重名策略一致。
 */
function copyNameParts(name: string): { base: string; ext: string } {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  const matched = stem.match(/^(.*?) copy(?: (\d+))?$/)
  return { base: matched ? matched[1] : stem, ext }
}

/** 在 dir 内为目标项生成不冲突的 “ copy” 名称（重名时依次递增编号）。 */
export function uniqueCopyPath(srcPath: string, dir: string): string {
  const { base, ext } = copyNameParts(basename(srcPath))
  let candidate = join(dir, `${base} copy${ext}`)
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(dir, `${base} copy ${n}${ext}`)
    n += 1
  }
  return candidate
}

/** 在 dir 下新建子目录。 */
export function makeDirectory(dir: string, name: unknown, roots: string[]): FsOpResult {
  const target = resolveWithinRoots(dir, roots)
  if ("error" in target) return target
  const safe = safeName(name)
  if (!safe) return { error: "目录名不合法" }
  const dest = join(target.abs, safe)
  if (!isWithinRoot(dest, target.root)) return { error: "目标路径越界" }
  if (existsSync(dest)) return { error: "同名文件或目录已存在", exists: true, path: dest }
  try {
    mkdirSync(dest)
  } catch (error) {
    return { error: `新建目录失败: ${(error as Error).message}` }
  }
  return { path: dest, name: safe }
}

/** 在 dir 下新建空文件。 */
export function createTextFile(dir: string, name: unknown, roots: string[]): FsOpResult {
  const target = resolveWithinRoots(dir, roots)
  if ("error" in target) return target
  const safe = safeName(name)
  if (!safe) return { error: "文件名不合法" }
  const dest = join(target.abs, safe)
  if (!isWithinRoot(dest, target.root)) return { error: "目标路径越界" }
  if (existsSync(dest)) return { error: "同名文件或目录已存在", exists: true, path: dest }
  try {
    writeFileSync(dest, "", { flag: "wx" })
  } catch (error) {
    return { error: `新建文件失败: ${(error as Error).message}` }
  }
  return { path: dest, name: safe }
}

/** 重命名（同目录内改名）。 */
export function renameEntry(path: string, name: unknown, roots: string[]): FsOpResult {
  const target = resolveWithinRoots(path, roots)
  if ("error" in target) return target
  if (isRootItself(target.abs, target.root)) return { error: "不能重命名根目录" }
  const safe = safeName(name)
  if (!safe) return { error: "名称不合法" }
  const dest = join(dirname(target.abs), safe)
  if (!isWithinRoot(dest, target.root)) return { error: "目标路径越界" }
  if (resolve(dest) === target.abs) return { from: target.abs, to: dest, name: safe }
  if (existsSync(dest)) return { error: "同名文件或目录已存在", exists: true, path: dest }
  try {
    renameSync(target.abs, dest)
  } catch (error) {
    return { error: `重命名失败: ${(error as Error).message}` }
  }
  return { from: target.abs, to: dest, name: safe }
}

/** 复制到目标目录（保留原文件 / 目录名；重名时按 “ copy” 规则自动改名）。 */
export function copyEntry(from: string, toDir: string, roots: string[], overwrite = false): FsOpResult {
  const src = resolveWithinRoots(from, roots)
  if ("error" in src) return src
  const dir = resolveWithinRoots(toDir, roots)
  if ("error" in dir) return dir
  let dest = join(dir.abs, basename(src.abs))
  if (!isWithinRoot(dest, dir.root)) return { error: "目标路径越界" }
  // 同一目录内复制（源与目标相同）也按 “ copy” 规则改名，而不是报错。
  const samePath = resolve(dest) === src.abs
  let renamed = false
  if (samePath || (existsSync(dest) && !overwrite)) {
    dest = uniqueCopyPath(src.abs, dir.abs)
    renamed = true
  }
  try {
    if (statSync(src.abs).isDirectory()) {
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
      cpSync(src.abs, dest, { recursive: true })
    } else {
      copyFileSync(src.abs, dest)
    }
  } catch (error) {
    return { error: `复制失败: ${(error as Error).message}` }
  }
  return { path: dest, name: basename(dest), renamed }
}

/** 移动到目标目录（剪切 / 粘贴；重名时按 “ copy” 规则自动改名）。 */
export function moveEntry(from: string, toDir: string, roots: string[], overwrite = false): FsOpResult {
  const src = resolveWithinRoots(from, roots)
  if ("error" in src) return src
  if (isRootItself(src.abs, src.root)) return { error: "不能移动根目录" }
  const dir = resolveWithinRoots(toDir, roots)
  if ("error" in dir) return dir
  let dest = join(dir.abs, basename(src.abs))
  if (!isWithinRoot(dest, dir.root)) return { error: "目标路径越界" }
  // 同一目录内剪切（源与目标相同）也生成 “ copy” 名称，与 VS Code 一致。
  const samePath = resolve(dest) === src.abs
  let renamed = false
  if (samePath || (existsSync(dest) && !overwrite)) {
    dest = uniqueCopyPath(src.abs, dir.abs)
    renamed = true
  }
  try {
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
    moveSync(src.abs, dest)
  } catch (error) {
    return { error: `移动失败: ${(error as Error).message}` }
  }
  return { from: src.abs, to: dest, path: dest, name: basename(dest), renamed }
}

/** 删除：移动到回收站（便于撤回），而不是直接抹除。 */
export function trashEntry(path: string, roots: string[], trashDir: string): FsOpResult {
  const target = resolveWithinRoots(path, roots)
  if ("error" in target) return target
  if (isRootItself(target.abs, target.root)) return { error: "不能删除根目录" }
  if (!existsSync(target.abs)) return { error: "目标不存在（可能已被删除）" }
  try {
    mkdirSync(trashDir, { recursive: true })
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const trashPath = join(trashDir, `${stamp}-${basename(target.abs)}`)
    moveSync(target.abs, trashPath)
    return { from: target.abs, trashPath }
  } catch (error) {
    return { error: `删除失败: ${(error as Error).message}` }
  }
}

/** 从回收站恢复（撤回删除）。 */
export function restoreFromTrash(trashPath: string, dest: string): FsOpResult {
  if (!existsSync(trashPath)) return { error: "回收站内容已丢失，无法撤回" }
  if (existsSync(dest)) return { error: "原位置已被占用，无法撤回" }
  try {
    mkdirSync(dirname(dest), { recursive: true })
    moveSync(trashPath, dest)
  } catch (error) {
    return { error: `撤回失败: ${(error as Error).message}` }
  }
  return { path: dest }
}
