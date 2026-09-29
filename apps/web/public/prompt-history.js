export function recentPrompts(messages, extra = []) {
  const visible = messages.filter((message) => message.role === "user" && message.text?.trim())
    .map((message) => message.text.trim()).reverse().slice(0, 3)
  // extra 是刚被撤销、已不在会话里的用户输入（最新在前）；补回到历史最前面，
  // 已经重新出现在会话里的（重发）不重复。
  const undone = extra.map((text) => String(text ?? "").trim()).filter(Boolean).filter((text) => !visible.includes(text))
  return [...undone, ...visible].slice(0, 3)
}

export function navigatePromptHistory(history, index, key, value, draft = "") {
  if (!history.length || (index < 0 && value.trim())) return null
  if (key === "ArrowUp") {
    const next = Math.min(index + 1, history.length - 1)
    return { index: next, value: history[next], draft: index < 0 ? value : draft }
  }
  if (key === "ArrowDown" && index >= 0) {
    const next = index - 1
    return { index: next, value: next < 0 ? draft : history[next], draft }
  }
  return null
}
