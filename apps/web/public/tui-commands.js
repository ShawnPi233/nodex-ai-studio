// OpenCode v1.17.20 TUI slash entries: packages/tui/src/app.tsx,
// routes/session/index.tsx and component/prompt/index.tsx. Only actions
// implemented by NodeX appear here; server /command entries are merged at runtime.
export const TUI_COMMANDS = [
  { name: "sessions", aliases: ["resume", "continue"], description: "切换会话", action: "sessions" },
  { name: "new", aliases: ["clear"], description: "新会话", action: "new" },
  { name: "models", aliases: ["mo"], description: "切换模型", action: "models" },
  { name: "agents", description: "切换 agent", action: "agents" },
  { name: "skills", description: "选择技能", action: "skills" },
  { name: "compose", description: "按协作模板拆分并执行任务", action: "server" },
  { name: "new_compose", aliases: ["new-compose", "newcompose"], description: "为未连接的节点新建协作模板", action: "new-compose" },
  { name: "compact", aliases: ["summarize"], description: "压缩会话", action: "compact" },
  { name: "fork", description: "从会话分支", action: "fork" },
  { name: "undo", aliases: ["revert"], description: "撤销上一步（回退最后一条消息）", action: "undo" },
  { name: "thinking", aliases: ["toggle-thinking"], description: "切换思考显示", action: "thinking" },
]

export function tuiCommand(name) {
  return TUI_COMMANDS.find((item) => item.name === name || item.aliases?.includes(name))
}

export function slashChoices(serverCommands, query = "") {
  const native = serverCommands
    .filter((item) => item.source !== "skill" && !tuiCommand(item.name))
    .map((item) => ({ name: item.name, description: item.description, action: "server" }))
  const text = query.toLowerCase()
  const matches = [...TUI_COMMANDS, ...native]
    .filter((item) => !text || [item.name, ...(item.aliases ?? []), item.description ?? ""].some((value) => value.toLowerCase().includes(text)))
    .sort((a, b) => {
      const rank = (item) => item.name.startsWith(text) ? 0 : item.aliases?.some((alias) => alias.startsWith(text)) ? 1 : 2
      return rank(a) - rank(b) || a.name.localeCompare(b.name)
    })
  return text ? matches.slice(0, 10) : matches
}
