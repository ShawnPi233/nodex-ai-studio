/**
 * NodeX Web 开发服务器。
 * 静态托管画布并提供 /api 反向代理，避免前端直连 OpenCode。
 */
import { join, resolve } from "node:path"

const PORT = Number(process.env.NODEX_WEB_PORT ?? 4600)
const API = process.env.NODEX_API ?? "http://127.0.0.1:4501"
const ROOT = resolve(import.meta.dir, "..")

// 开发诊断页：确认浏览器 / 光标主题是否会渲染各种 cursor 值。
// 既测系统内置 cursor 名，也测自定义图片 cursor（可绕过系统主题缺图）。
// 单引号一律编码成 %27，避免和 CSS url('...') 的引号冲突。
const HAND_SVG = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2728%27 height=%2728%27 viewBox=%270 0 24 24%27 fill=%27white%27 stroke=%27black%27 stroke-width=%271.5%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27M18 11V6a2 2 0 0 0-4 0v5%27/%3E%3Cpath d=%27M14 10V4a2 2 0 0 0-4 0v6%27/%3E%3Cpath d=%27M10 10.5V6a2 2 0 0 0-4 0v8%27/%3E%3Cpath d=%27M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15%27/%3E%3C/svg%3E"
const CURSOR_TEST_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<title>cursor 诊断</title>
<style>
  body { font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 24px; background: #0b0d12; color: #e6e8ee; }
  h1 { font-size: 16px; }
  .banner { border: 1px solid #6366f1; background: #1e1b4b; border-radius: 8px; padding: 12px 14px; margin: 12px 0; font-size: 13px; line-height: 1.7; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; margin-top: 16px; }
  .cell { border: 1px solid #2a2f3a; border-radius: 8px; padding: 14px; background: #12151c; }
  .cell b { display: block; font-size: 12px; color: #a5b4fc; margin-bottom: 6px; }
  .sample { border: 1px dashed #3a4152; border-radius: 6px; padding: 18px 10px; text-align: center; }
  .hint { color: #8b93a7; margin-top: 16px; font-size: 12px; }
</style></head><body>
<h1>cursor 诊断</h1>
<div class="banner">
  把鼠标依次移到下面每个方框上，观察指针形状有没有变化：<br />
  ① 只要 <b>pointer / text / grab / 自定义图片</b> 中任意一个变了，说明浏览器能改指针，问题在别处；<br />
  ② 如果连「自定义图片」和 text 都不变，说明是<b>浏览器扩展或系统级工具</b>在接管指针。<br />
  决定性验证：用 <b>InPrivate 无痕窗口</b>（默认禁用扩展）打开本页，再对比。
</div>
<div class="grid" id="grid"></div>
<p class="hint" id="report">正在上报环境信息…</p>
<script>
  const items = [
    ["default", "default"], ["pointer", "pointer"], ["text", "text"],
    ["grab", "grab"], ["grabbing", "grabbing"], ["move", "move"],
    ["自定义图片 hand", "url('${HAND_SVG}') 8 4, grab"],
  ];
  document.getElementById("grid").innerHTML = items.map(([label, c]) =>
    '<div class="cell"><b>' + label + '</b><div class="sample" style="cursor:' + c + '">移到这里</div></div>'
  ).join("");
  const info = {
    ua: navigator.userAgent,
    iframe: window.top !== window.self,
    dpr: window.devicePixelRatio,
    touch: navigator.maxTouchPoints || 0,
  };
  document.getElementById("report").textContent =
    "环境：" + info.ua + " · iframe=" + info.iframe + " · dpr=" + info.dpr + " · touch=" + info.touch;
  fetch("/__cursor-report?ua=" + encodeURIComponent(info.ua) + "&iframe=" + info.iframe + "&dpr=" + info.dpr + "&touch=" + info.touch).catch(() => {});
</script>
</body></html>`

const server = Bun.serve({
  port: PORT,
  // Keep the reverse proxy open while a model has a long quiet period.
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)

    // 光标诊断：记录首页与诊断页的 User-Agent / iframe 信息，便于定位
    // 「代码正确但光标不变」是否由查看方式（webview / 远程串流）导致。
    if (url.pathname === "/" || url.pathname === "/__cursor-test" || url.pathname === "/__cursor-report") {
      const ua = req.headers.get("user-agent") ?? "-"
      console.log(`[nodex] ${req.method} ${url.pathname}${url.search} ua="${ua}"`)
    }

    if (url.pathname.startsWith("/api/")) {
      const target = `${API}${url.pathname.replace(/^\/api/, "")}${url.search}`
      // 禁用 Bun fetch 默认的 5 分钟超时：模型等待用户回答或长时间输出时，
      // SSE 可能长时间没有数据，默认超时会把流截断成错误。
      const upstream = new Request(target, {
        method: req.method,
        headers: { "content-type": req.headers.get("content-type") ?? "application/json" },
        body: req.method === "GET" ? undefined : await req.text(),
      })
      upstream.timeout = false
      const res = await fetch(upstream)
      return new Response(res.body, {
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store, max-age=0",
        },
      })
    }

    const vendor: Record<string, string> = {
      "/vendor/marked.js": "marked/lib/marked.esm.js",
      "/vendor/dompurify.js": "dompurify/dist/purify.es.mjs",
    }
    if (vendor[url.pathname]) {
      const file = Bun.file(join(ROOT, "node_modules", vendor[url.pathname]))
      return await file.exists()
        ? new Response(file, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store, max-age=0" } })
        : new Response("not found", { status: 404 })
    }

    // KaTeX（公式排版）静态资源：/vendor/katex/dist/... -> node_modules/katex/dist/...
    // 目录结构保持一致，CSS 里的 url(fonts/...) 与 ESM 里的相对 import 才能解析。
    if (url.pathname.startsWith("/vendor/katex/")) {
      const rel = url.pathname.slice("/vendor/katex/".length)
      if (!rel || rel.includes("..")) return new Response("forbidden", { status: 403 })
      const file = Bun.file(join(ROOT, "node_modules/katex", rel))
      if (!(await file.exists())) return new Response("not found", { status: 404 })
      const type = rel.endsWith(".css") ? "text/css; charset=utf-8"
        : rel.endsWith(".mjs") ? "text/javascript; charset=utf-8"
        : rel.endsWith(".js") ? "text/javascript; charset=utf-8"
        : rel.endsWith(".woff2") ? "font/woff2"
        : rel.endsWith(".woff") ? "font/woff"
        : rel.endsWith(".ttf") ? "font/ttf"
        : "application/octet-stream"
      return new Response(file, { headers: { "content-type": type, "cache-control": "no-store, max-age=0" } })
    }

    // Monaco（VS Code 编辑器内核）静态资源：/vendor/monaco/vs/... -> node_modules/monaco-editor/min/vs/...
    if (url.pathname.startsWith("/vendor/monaco/")) {
      const rel = url.pathname.slice("/vendor/monaco/".length)
      if (!rel || rel.includes("..")) return new Response("forbidden", { status: 403 })
      const file = Bun.file(join(ROOT, "node_modules/monaco-editor/min", rel))
      if (!(await file.exists())) return new Response("not found", { status: 404 })
      const type = rel.endsWith(".js") ? "text/javascript; charset=utf-8"
        : rel.endsWith(".css") ? "text/css; charset=utf-8"
        : rel.endsWith(".json") ? "application/json; charset=utf-8"
        : rel.endsWith(".ttf") ? "font/ttf"
        : "text/plain; charset=utf-8"
      return new Response(file, { headers: { "content-type": type, "cache-control": "no-store, max-age=0" } })
    }

    if (url.pathname === "/__cursor-test") {
      return new Response(CURSOR_TEST_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, max-age=0" },
      })
    }

    if (url.pathname === "/__cursor-report") {
      return new Response(null, { status: 204, headers: { "cache-control": "no-store, max-age=0" } })
    }

    const file = url.pathname === "/" ? "/index.html" : url.pathname
    const path = join(ROOT, "public", file)
    if (!path.startsWith(join(ROOT, "public"))) {
      return new Response("forbidden", { status: 403 })
    }
    const bunFile = Bun.file(path)
    if (!(await bunFile.exists())) return new Response("not found", { status: 404 })
    // 开发预览禁用缓存：避免浏览器继续使用旧的 index.html / app.js，
    // 导致 CSS 与脚本改动看不到效果。
    return new Response(bunFile, { headers: { "cache-control": "no-store, max-age=0" } })
  },
})

console.log(`[nodex] Web 画布 http://127.0.0.1:${server.port}`)
console.log(`[nodex] API 代理 -> ${API}`)
