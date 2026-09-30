import type * as vscode from "vscode"

const escapeAttr = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const originOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/**
 * 内嵌 NodeX 网页画布：外层只负责提供一个铺满的 iframe，指向本地 NodeX 网页服务。
 * 与浏览器打开同一个网页端，文件侧栏 / 文件预览等能力完全一致。
 */
export function renderWebviewHtml(webview: vscode.Webview, webUrl: string, _mode: "sidebar" | "panel"): string {
  const base = webUrl.replace(/\/+$/, "")
  const src = `${base}/`
  const csp = [
    "default-src 'none'",
    `frame-src ${originOf(base)} ${webview.cspSource}`,
    "style-src 'unsafe-inline'",
  ].join("; ")
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html, body { height: 100%; width: 100%; margin: 0; padding: 0; background: var(--vscode-editor-background, #0b0d12); }
  #nodex-frame { display: block; border: 0; height: 100%; width: 100%; }
</style>
</head>
<body>
<iframe id="nodex-frame" src="${escapeAttr(src)}" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
</body>
</html>`
}

/** 服务未就绪时的提示页；附带可点击的重试 / 浏览器打开命令链接。 */
export function renderMessageHtml(message: string, canRetry = true): string {
  const retry = canRetry
    ? `<p class="actions"><a href="command:nodex.restartServer">重试</a> · <a href="command:nodex.openInBrowser">在浏览器打开</a></p>`
    : ""
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
    padding: 24px; text-align: center; box-sizing: border-box;
    background: var(--vscode-editor-background, #0b0d12); color: var(--vscode-foreground, #e6e8ee);
    font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 13px; line-height: 1.6;
  }
  .title { font-size: 15px; font-weight: 600; }
  .muted { color: var(--vscode-descriptionForeground, #8b93a7); }
  .actions a { color: var(--vscode-textLink-foreground, #6ea8fe); text-decoration: none; }
  .actions a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <div class="title">NodeX</div>
  <div>${escapeAttr(message)}</div>
  ${retry}
</body>
</html>`
}
