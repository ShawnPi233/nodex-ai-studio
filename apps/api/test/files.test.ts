import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import {
  classifyFile,
  collectNodeFiles,
  copyEntry,
  createTextFile,
  directionOf,
  isWithinRoot,
  languageOf,
  listDirectory,
  makeDirectory,
  mimeOf,
  moveEntry,
  readFileForPreview,
  readRawFile,
  renameEntry,
  restoreFromTrash,
  trashEntry,
  uniqueCopyPath,
} from "../src/files.ts"

test("classifyFile 按扩展名归类", () => {
  assert.equal(classifyFile("/a/index.html"), "html")
  assert.equal(classifyFile("/a/README.md"), "markdown")
  assert.equal(classifyFile("/a/data.json"), "json")
  assert.equal(classifyFile("/a/logs.jsonl"), "jsonl")
  assert.equal(classifyFile("/a/main.py"), "code")
  assert.equal(classifyFile("/a/cover.png"), "image")
  assert.equal(classifyFile("/a/voice.mp3"), "audio")
  assert.equal(classifyFile("/a/clip.mp4"), "video")
  assert.equal(classifyFile("/a/bundle.zip"), "archive")
  assert.equal(classifyFile("/a/pkg.tar.gz"), "archive")
  assert.equal(classifyFile("/a/notes.txt"), "text")
  assert.equal(classifyFile("/a/blob.bin"), "text")
})

test("mimeOf / languageOf 覆盖常用类型", () => {
  assert.equal(mimeOf("/a/x.jsonl"), "application/x-ndjson")
  assert.equal(mimeOf("/a/x.png"), "image/png")
  assert.equal(languageOf("/a/x.py"), "python")
  assert.equal(languageOf("/a/x.ts"), "typescript")
})

test("collectNodeFiles 从 tool/file part 提取文件并去重", () => {
  const root = "/root"
  const messages = [
    {
      id: "m1",
      role: "assistant" as const,
      parts: [
        { type: "tool", tool: "write", state: { input: { filePath: "/root/a.md" } } },
        { type: "tool", tool: "edit", state: { input: { filePath: "/root/a.md" } } },
        { type: "tool", tool: "read", state: { input: { path: "/root/b.py" } } },
        { type: "tool", tool: "bash", state: { input: { command: "ls" } } },
        { type: "file", filename: "/root/c.png", mime: "image/png" },
      ],
    },
  ]
  const files = collectNodeFiles(messages as any, root)
  const paths = files.map((f) => f.path).sort()
  assert.deepEqual(paths, ["/root/a.md", "/root/b.py", "/root/c.png"])
  assert.equal(files.find((f) => f.path === "/root/a.md")?.tool, "write")
  assert.equal(files.find((f) => f.path === "/root/c.png")?.kind, "image")
})

test("collectNodeFiles 相对路径按根目录解析，不存在的文件保留但标记", () => {
  const files = collectNodeFiles(
    [{ id: "m", role: "assistant" as const, parts: [{ type: "tool", tool: "write", state: { input: { filePath: "out/x.json" } } }] }] as any,
    "/base",
  )
  assert.equal(files[0].path, "/base/out/x.json")
  assert.equal(files[0].exists, false)
  assert.equal(files[0].kind, "json")
})

test("isWithinRoot 拒绝越界与符号链接逃逸", () => {
  const root = mkdtempSync(join(tmpdir(), "nodex-root-"))
  const inside = join(root, "a.txt")
  writeFileSync(inside, "hi")
  assert.equal(isWithinRoot(inside, root), true)
  assert.equal(isWithinRoot(tmpdir(), root), false)
})

test("readFileForPreview 读取文本并识别类型，越界返回错误", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nodex-root-")))
  mkdirSync(join(root, "sub"))
  writeFileSync(join(root, "sub", "n.json"), '{"a":1}')

  const view = readFileForPreview(join(root, "sub", "n.json"), root)
  assert.ok(!("error" in view))
  if (!("error" in view)) {
    assert.equal(view.kind, "json")
    assert.equal(view.encoding, "utf8")
    assert.equal(view.rel, join("sub", "n.json"))
    assert.equal(view.content, '{"a":1}')
  }

  const escaped = readFileForPreview("/etc/passwd", root)
  assert.ok("error" in escaped)

  const missing = readFileForPreview(join(root, "nope.txt"), root)
  assert.ok("error" in missing)
})

test("readFileForPreview 二进制返回 base64", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nodex-root-")))
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  writeFileSync(join(root, "i.png"), png)
  const view = readFileForPreview(join(root, "i.png"), root)
  assert.ok(!("error" in view))
  if (!("error" in view)) {
    assert.equal(view.encoding, "base64")
    assert.equal(view.kind, "image")
    assert.equal(Buffer.from(view.content, "base64").toString("hex"), png.toString("hex"))
  }
})

test("readFileForPreview 压缩包与疑似二进制不预览", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nodex-root-")))
  writeFileSync(join(root, "bundle.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  const zip = readFileForPreview(join(root, "bundle.zip"), root)
  assert.ok("error" in zip)

  // 未知扩展名但含 NUL 字节：按文本读取会乱码，应明确拒绝。
  writeFileSync(join(root, "weird.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00]))
  const bin = readFileForPreview(join(root, "weird.dat"), root)
  assert.ok("error" in bin)
})

test("directionOf 按工具名区分输入/输出", () => {
  assert.equal(directionOf("read"), "input")
  assert.equal(directionOf("grep"), "input")
  assert.equal(directionOf("write"), "output")
  assert.equal(directionOf("multiedit"), "output")
  assert.equal(directionOf("bash"), "unknown")
})

test("collectNodeFiles 标注文件方向，写入优先", () => {
  const messages = [
    {
      id: "m1",
      role: "assistant" as const,
      parts: [
        { type: "tool", tool: "read", state: { input: { filePath: "/root/a.md" } } },
        { type: "tool", tool: "write", state: { input: { filePath: "/root/a.md" } } },
        { type: "tool", tool: "read", state: { input: { path: "/root/b.py" } } },
      ],
    },
  ]
  const files = collectNodeFiles(messages as any, "/root")
  assert.equal(files.find((f) => f.path === "/root/a.md")?.direction, "output")
  assert.equal(files.find((f) => f.path === "/root/b.py")?.direction, "input")
})

test("listDirectory 列出目录并拒绝越界", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nodex-list-")))
  mkdirSync(join(root, "sub"))
  writeFileSync(join(root, "a.md"), "hi")
  writeFileSync(join(root, "sub", "b.txt"), "yo")

  const listing = listDirectory(root, [root])
  assert.ok(!("error" in listing))
  if (!("error" in listing)) {
    assert.equal(listing.entries.length, 2)
    assert.equal(listing.entries[0].type, "dir")
    assert.equal(listing.entries[0].name, "sub")
    assert.equal(listing.entries[1].name, "a.md")
    assert.equal(listing.entries[1].kind, "markdown")
  }

  const nested = listDirectory(join(root, "sub"), [root])
  assert.ok(!("error" in nested))
  if (!("error" in nested)) {
    assert.equal(nested.entries[0].name, "b.txt")
    assert.equal(nested.rel, "sub")
  }

  const outside = listDirectory(tmpdir(), [root])
  assert.ok("error" in outside)
})

test("makeDirectory / createTextFile 新建且拒绝重名与非法名", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nodex-mk-")))
  const dir = makeDirectory(root, "notes", [root])
  assert.ok(!("error" in dir))
  const file = createTextFile(root, "a.md", [root])
  assert.ok(!("error" in file))

  const listing = listDirectory(root, [root])
  assert.ok(!("error" in listing))
  if (!("error" in listing)) {
    assert.deepEqual(listing.entries.map((e) => e.name), ["notes", "a.md"])
  }

  assert.ok("error" in makeDirectory(root, "notes", [root]))
  assert.ok("error" in createTextFile(root, "../escape", [root]))
  assert.ok("error" in createTextFile(root, "a/b", [root]))
})

test("renameEntry 改名并可拒绝重名", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nodex-rename-")))
  writeFileSync(join(root, "a.txt"), "hi")
  const renamed = renameEntry(join(root, "a.txt"), "b.txt", [root])
  assert.ok(!("error" in renamed))
  assert.equal(renamed.to, join(root, "b.txt"))

  writeFileSync(join(root, "c.txt"), "yo")
  assert.ok("error" in renameEntry(join(root, "b.txt"), "c.txt", [root]))
  assert.ok("error" in renameEntry(root, "root2", [root]))
})

test("copyEntry / moveEntry 复制与移动目录内容", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nodex-cp-")))
  mkdirSync(join(root, "src"))
  mkdirSync(join(root, "dst"))
  writeFileSync(join(root, "src", "x.txt"), "hello")

  const copied = copyEntry(join(root, "src"), join(root, "dst"), [root])
  assert.ok(!("error" in copied))
  assert.ok(existsSync(join(root, "dst", "src", "x.txt")))

  mkdirSync(join(root, "moved"))
  const moved = moveEntry(join(root, "dst", "src"), join(root, "moved"), [root])
  assert.ok(!("error" in moved))
  assert.ok(existsSync(join(root, "moved", "src", "x.txt")))
  assert.ok(!existsSync(join(root, "dst", "src")))
})

test("uniqueCopyPath 生成 VS Code 式 copy 名称", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nodex-copy-name-")))
  writeFileSync(join(root, "a.txt"), "1")
  assert.equal(basename(uniqueCopyPath(join(root, "a.txt"), root)), "a copy.txt")

  writeFileSync(join(root, "a copy.txt"), "2")
  assert.equal(basename(uniqueCopyPath(join(root, "a.txt"), root)), "a copy 2.txt")
  assert.equal(basename(uniqueCopyPath(join(root, "a copy.txt"), root)), "a copy 2.txt")

  writeFileSync(join(root, "a copy 2.txt"), "3")
  assert.equal(basename(uniqueCopyPath(join(root, "a copy 2.txt"), root)), "a copy 3.txt")

  mkdirSync(join(root, "folder"))
  mkdirSync(join(root, "folder copy"))
  assert.equal(basename(uniqueCopyPath(join(root, "folder"), root)), "folder copy 2")
})

test("copyEntry / moveEntry 重名自动改名而非覆盖", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nodex-copy-dup-")))
  mkdirSync(join(root, "dst"))
  writeFileSync(join(root, "a.txt"), "origin")
  writeFileSync(join(root, "dst", "a.txt"), "existing")

  const copied = copyEntry(join(root, "a.txt"), join(root, "dst"), [root])
  assert.ok(!("error" in copied))
  assert.equal(copied.renamed, true)
  assert.equal(copied.name, "a copy.txt")
  assert.equal(readFileSync(join(root, "dst", "a.txt"), "utf8"), "existing")
  assert.equal(readFileSync(join(root, "dst", "a copy.txt"), "utf8"), "origin")

  const moved = moveEntry(join(root, "a.txt"), join(root, "dst"), [root])
  assert.ok(!("error" in moved))
  assert.equal(moved.renamed, true)
  assert.equal(moved.name, "a copy 2.txt")
  assert.ok(!existsSync(join(root, "a.txt")))
})

test("copyEntry / moveEntry 同目录复制与剪切按 copy 规则改名", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nodex-samedir-")))
  writeFileSync(join(root, "a.txt"), "origin")

  const copied = copyEntry(join(root, "a.txt"), root, [root])
  assert.ok(!("error" in copied))
  assert.equal(copied.renamed, true)
  assert.equal(copied.name, "a copy.txt")
  assert.ok(existsSync(join(root, "a.txt")))
  assert.equal(readFileSync(join(root, "a copy.txt"), "utf8"), "origin")

  const moved = moveEntry(join(root, "a.txt"), root, [root])
  assert.ok(!("error" in moved))
  assert.equal(moved.renamed, true)
  assert.equal(moved.name, "a copy 2.txt")
  assert.ok(!existsSync(join(root, "a.txt")))
  assert.ok(existsSync(join(root, "a copy 2.txt")))
})

test("trashEntry / restoreFromTrash 支持撤回删除", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nodex-trash-")))
  const trash = mkdtempSync(join(tmpdir(), "nodex-trashdir-"))
  writeFileSync(join(root, "gone.txt"), "bye")

  const trashed = trashEntry(join(root, "gone.txt"), [root], trash)
  assert.ok(!("error" in trashed))
  assert.ok(!existsSync(join(root, "gone.txt")))
  assert.ok(trashed.trashPath && existsSync(trashed.trashPath))

  const restored = restoreFromTrash(trashed.trashPath!, trashed.from!)
  assert.ok(!("error" in restored))
  assert.ok(existsSync(join(root, "gone.txt")))
})

test("readRawFile 返回原始字节并拒绝目录与越界", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nodex-raw-")))
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  writeFileSync(join(root, "i.png"), png)
  const raw = readRawFile(join(root, "i.png"), [root])
  assert.ok(!("error" in raw))
  if (!("error" in raw)) {
    assert.equal(raw.mime, "image/png")
    assert.equal(raw.buffer.toString("hex"), png.toString("hex"))
  }
  assert.ok("error" in readRawFile(root, [root]))
  assert.ok("error" in readRawFile("/etc/passwd", [root]))
})
