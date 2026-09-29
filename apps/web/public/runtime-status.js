/**
 * 运行时状态相关的纯判定（供 app.js 使用并单测）。
 *
 * 服务端 `/runtime/status` 返回的 `sessions` 只包含 busy/retry 会话，
 * 并带 `available` 标记状态是否可信。拿不到权威状态时（available=false）
 * 一律不得当作空闲，避免把排队消息误发到仍在运行的会话上。
 */

/** 会话是否处于活跃态。状态不可用、或会话不在 busy 集合里都算不活跃。 */
export function sessionIsActive(sessionId, runtimeStatus, statusAvailable) {
  return Boolean(statusAvailable) && Boolean(sessionId) &&
    runtimeStatus instanceof Map && runtimeStatus.has(sessionId)
}

/**
 * 是否允许续发排队消息：状态可用、有排队消息、不在发送中、且会话空闲。
 * 任一条不满足（尤其状态不可用）都不续发。
 */
export function canDrainQueue({ statusAvailable, runtimeStatus, sessionId, sending = false, queueLength = 0 }) {
  if (statusAvailable !== true) return false
  if (sending) return false
  if (!queueLength) return false
  return !sessionIsActive(sessionId, runtimeStatus, statusAvailable)
}

/**
 * 找出应被本地标记为「已中断」的尾部助手消息 id。
 *
 * 仅当：权威状态可用、会话空闲、未在发送、无待处理问答，且最后一条是
 * 尚未完成（没有 finish）的助手消息时成立。用于避免中断后 UI 一直像是
 * 「正在生成」或显示一条没有结论的空白回复。
 */
export function abortedTailMessageId(messages, { statusAvailable, active = false, sending = false, hasQuestion = false }) {
  if (statusAvailable !== true) return null
  if (active || sending || hasQuestion) return null
  const last = (messages ?? []).at(-1)
  if (!last || last.role !== "assistant" || last.finish) return null
  return last.id ?? null
}

