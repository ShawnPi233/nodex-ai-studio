import * as vscode from "vscode"
import { NodexServer } from "./server"
import { renderMessageHtml, renderWebviewHtml } from "./webview"

const VIEW_ID = "nodex.canvas"
const COMMAND_URIS = ["nodex.restartServer", "nodex.openInBrowser"]

let server: NodexServer | undefined
let output: vscode.OutputChannel | undefined
let panel: vscode.WebviewPanel | undefined
const boundViews = new Set<vscode.Webview>()

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("NodeX")
  server = new NodexServer(context.extensionUri, output)
  context.subscriptions.push(output, { dispose: () => server?.stop() })

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      VIEW_ID,
      {
        resolveWebviewView: (view) => {
          view.onDidDispose(() => boundViews.delete(view.webview))
          void bindWebview(view.webview)
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand("nodex.openCanvas", () => openPanel()),
    vscode.commands.registerCommand("nodex.openInBrowser", async () => {
      const url = await ensureServer()
      if (url) await vscode.env.openExternal(vscode.Uri.parse(await externalUrl(url)))
    }),
    vscode.commands.registerCommand("nodex.restartServer", () => restartServer()),
    vscode.commands.registerCommand("nodex.showStatus", async () => {
      const url = server?.currentUrl() ?? (await ensureServer())
      void vscode.window.showInformationMessage(url ? `NodeX 正在运行：${url}` : "NodeX 未运行")
    }),
  )
}

export function deactivate(): void {
  server?.stop()
}

function configureWebview(webview: vscode.Webview): void {
  webview.options = { enableScripts: true, enableCommandUris: COMMAND_URIS }
}

async function bindWebview(webview: vscode.Webview): Promise<void> {
  configureWebview(webview)
  if (boundViews.has(webview)) return
  boundViews.add(webview)
  webview.html = renderMessageHtml("正在连接 NodeX…", false)
  const url = await ensureServer()
  webview.html = url
    ? renderWebviewHtml(webview, await externalUrl(url), "panel")
    : renderMessageHtml("未能启动 NodeX 本地服务。请检查设置，或在其他终端运行 bash scripts/dev.sh 后重试。")
}

async function ensureServer(): Promise<string | undefined> {
  try {
    return await server?.ensure()
  } catch (error) {
    output?.appendLine(`[nodex] 启动失败：${String(error)}`)
    return undefined
  }
}

/**
 * Remote / Codespaces 下 webview 在本地渲染，需把远端 localhost 地址经端口转发解析成客户端可达地址；
 * 桌面本地下返回原地址。
 */
async function externalUrl(raw: string): Promise<string> {
  try {
    return (await vscode.env.asExternalUri(vscode.Uri.parse(raw))).toString().replace(/\/+$/, "")
  } catch {
    return raw
  }
}

function openPanel(): void {
  if (panel) {
    panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active)
    return
  }
  panel = vscode.window.createWebviewPanel(VIEW_ID, "NodeX", vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    enableCommandUris: COMMAND_URIS,
  })
  const webview = panel.webview
  panel.onDidDispose(() => {
    boundViews.delete(webview)
    panel = undefined
  })
  void bindWebview(webview)
}

async function restartServer(): Promise<void> {
  server?.stop()
  const url = await ensureServer()
  if (!url) {
    void vscode.window.showWarningMessage("NodeX：重启后仍不可用，详见「NodeX」输出面板。")
    return
  }
  const resolved = await externalUrl(url)
  for (const webview of boundViews) webview.html = renderWebviewHtml(webview, resolved, "panel")
  void vscode.window.showInformationMessage(`NodeX 已就绪：${url}`)
}
