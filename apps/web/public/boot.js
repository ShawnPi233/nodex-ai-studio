// 首次绘制前应用主题，避免浅色主题先闪一下深色背景。
(() => {
  let theme = "default"
  let appearance = "system"
  try { theme = localStorage.getItem("nodex.theme") || "default" } catch { /* Ignore blocked storage. */ }
  try { appearance = localStorage.getItem("nodex.appearance") || "system" } catch { /* Ignore blocked storage. */ }
  // 兼容旧值：dark / light / system 曾是主题本身，迁移成「默认主题 + 外观」。
  if (["dark", "light", "system"].includes(theme)) { appearance = theme; theme = "default" }
  if (!["default", "mac"].includes(theme)) theme = "default"
  if (!["dark", "light", "system"].includes(appearance)) appearance = "system"
  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches
  let effective
  if (theme === "mac") effective = (appearance === "light" || (appearance === "system" && prefersLight)) ? "mac" : "mac-dark"
  else effective = appearance
  const base = effective === "mac" ? "light" : effective === "mac-dark" ? "dark"
    : effective === "light" || (effective === "system" && prefersLight) ? "light" : "dark"
  document.documentElement.dataset.theme = effective
  document.documentElement.dataset.themeBase = base
})();

// 宿主标识：VS Code 插件以 ?host=vscode 内嵌时，文件侧栏与文件预览交给编辑器，
// 网页端据此隐藏对应入口（不影响独立网页画布）。
(() => {
  try {
    const host = new URLSearchParams(location.search).get("host") || window.__NODEX_HOST__ || ""
    if (host) document.documentElement.dataset.host = host
  } catch { /* Ignore blocked storage / URL parsing. */ }
})();
