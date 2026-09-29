import * as vscode from "vscode"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

// 探测常见端口：dev.sh 默认 4600，本机预览可能是别的端口（这里额外带上 4627）。
const WEB_PORT_CANDIDATES = [4600, 4627]
const API_PORT = 4501
const WEB_PORT = 4600
const OPENCODE_PORT_CANDIDATES = [4096, 4199]
const PATH_SEP = process.platform === "win32" ? ";" : ":"

async function fetchWithTimeout(url: string, ms: number): Promise<Response | undefined> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(ms) })
  } catch {
    return undefined
  }
}

/** 判断某个地址是否是 NodeX 网页（返回 200 且页面里带 NodeX 标识）。 */
async function isNodexPage(base: string): Promise<boolean> {
  const res = await fetchWithTimeout(`${base.replace(/\/+$/, "")}/`, 1500)
  if (!res || !res.ok) return false
  try {
    return /nodex/i.test(await res.text())
  } catch {
    return false
  }
}

async function isOk(url: string): Promise<boolean> {
  const res = await fetchWithTimeout(url, 1500)
  return Boolean(res && res.ok)
}

/** 轮询直到检查通过或超时。 */
function waitUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = async (): Promise<void> => {
      if (await check()) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(() => void tick(), intervalMs)
    }
    void tick()
  })
}

/**
 * NodeX 本地服务管理器：优先复用已运行的实例，找不到再按需拉起 API 与网页服务。
 * 只负责网页地址（网页服务已自带 /api 反向代理），失败时抛错交给上层提示。
 */
export class NodexServer {
  private api?: ChildProcess
  private web?: ChildProcess
  private webUrl: string | undefined

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly out: vscode.OutputChannel,
  ) {}

  currentUrl(): string | undefined {
    return this.webUrl
  }

  async ensure(): Promise<string | undefined> {
    const cfg = vscode.workspace.getConfiguration("nodex")
    const configured = (cfg.get<string>("webUrl") ?? "").trim().replace(/\/+$/, "")
    if (configured) {
      if (await isNodexPage(configured)) {
        this.webUrl = configured
        this.out.appendLine(`[nodex] 使用配置的实例：${configured}`)
        return configured
      }
      this.out.appendLine(`[nodex] nodex.webUrl=${configured} 未响应 NodeX 页面，继续探测。`)
    }

    for (const port of WEB_PORT_CANDIDATES) {
      const url = `http://127.0.0.1:${port}`
      if (await isNodexPage(url)) {
        this.webUrl = url
        this.out.appendLine(`[nodex] 复用已运行实例：${url}`)
        return url
      }
    }

    if (cfg.get<boolean>("autoStart") === false) {
      this.out.appendLine("[nodex] 未发现运行中的 NodeX，且 nodex.autoStart 已关闭。")
      return undefined
    }
    return this.start()
  }

  stop(): void {
    for (const proc of [this.api, this.web]) {
      if (!proc || proc.killed) continue
      proc.kill()
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL")
      }, 1500)
    }
    this.api = undefined
    this.web = undefined
    this.webUrl = undefined
  }

  private findRepo(): string | undefined {
    const configured = (vscode.workspace.getConfiguration("nodex").get<string>("repoPath") ?? "").trim()
    const candidates = [
      configured,
      resolve(this.extensionUri.fsPath, "..", ".."),
      ...(vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    ]
    for (const candidate of candidates) {
      if (candidate && existsSync(join(candidate, "apps", "api", "src", "server.ts"))) return candidate
    }
    return undefined
  }

  private findBun(repo: string): string | undefined {
    const configured = (vscode.workspace.getConfiguration("nodex").get<string>("bunPath") ?? "").trim()
    if (configured && existsSync(configured)) return configured
    const local = join(repo, ".tools", "bin", process.platform === "win32" ? "bun.exe" : "bun")
    if (existsSync(local)) return local
    const name = process.platform === "win32" ? "bun.exe" : "bun"
    for (const dir of (process.env.PATH ?? "").split(PATH_SEP)) {
      if (dir && existsSync(join(dir, name))) return join(dir, name)
    }
    return undefined
  }

  private async findOpenCode(): Promise<string | undefined> {
    const configured = (vscode.workspace.getConfiguration("nodex").get<string>("opencodeUrl") ?? "").trim()
    if (configured) return configured.replace(/\/+$/, "")
    for (const port of OPENCODE_PORT_CANDIDATES) {
      const url = `http://127.0.0.1:${port}`
      if (await isOk(`${url}/global/health`)) return url
    }
    return undefined
  }

  private log(child: ChildProcess, tag: string): void {
    child.stdout?.on("data", (data: Buffer) => this.out.append(`[${tag}] ${data.toString()}`))
    child.stderr?.on("data", (data: Buffer) => this.out.append(`[${tag}] ${data.toString()}`))
    child.on("exit", (code) => this.out.appendLine(`[nodex] ${tag} 退出（code=${code}）`))
  }

  private async start(): Promise<string | undefined> {
    const repo = this.findRepo()
    if (!repo) {
      void vscode.window.showErrorMessage("NodeX：找不到仓库根目录，请在设置 nodex.repoPath 中指定。")
      return undefined
    }
    const bun = this.findBun(repo)
    if (!bun) {
      void vscode.window.showErrorMessage("NodeX：找不到 bun，请先安装 bun 或设置 nodex.bunPath。")
      return undefined
    }
    const opencode = await this.findOpenCode()
    if (!opencode) {
      void vscode.window.showErrorMessage("NodeX：找不到 OpenCode Server，请先运行 opencode serve，或设置 nodex.opencodeUrl。")
      return undefined
    }

    this.out.appendLine(`[nodex] 拉起本地服务：repo=${repo} opencode=${opencode}`)
    this.api = spawn(bun, ["run", join(repo, "apps", "api", "src", "server.ts")], {
      cwd: repo,
      env: {
        ...process.env,
        OPENCODE_BASE_URL: opencode,
        NODEX_PORT: String(API_PORT),
        NODEX_DATA_DIR: join(repo, "runs"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.log(this.api, "api")
    if (!(await waitUntil(() => isOk(`http://127.0.0.1:${API_PORT}/health`), 30000))) {
      void vscode.window.showErrorMessage("NodeX：API 启动失败，详见「NodeX」输出面板。")
      this.stop()
      return undefined
    }

    this.web = spawn(bun, ["run", join(repo, "apps", "web", "src", "dev.ts")], {
      cwd: repo,
      env: {
        ...process.env,
        NODEX_WEB_PORT: String(WEB_PORT),
        NODEX_API: `http://127.0.0.1:${API_PORT}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.log(this.web, "web")
    const url = `http://127.0.0.1:${WEB_PORT}`
    if (!(await waitUntil(() => isNodexPage(url), 20000))) {
      void vscode.window.showErrorMessage("NodeX：网页服务启动失败，详见「NodeX」输出面板。")
      this.stop()
      return undefined
    }

    this.webUrl = url
    this.out.appendLine(`[nodex] 就绪：${url}`)
    return url
  }
}
