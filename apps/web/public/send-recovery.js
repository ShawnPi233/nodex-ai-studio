/**
 * 流式发送失败后的恢复判定（纯函数，便于单测）。
 *
 * 请求一旦离开客户端后失败即属「歧义」：不能直接重发（可能产生双回复），
 * 而是读回会话，判断本次消息是否已写入、其后的助手回复是否已完整完成。
 */

/**
 * @param {Array<{id:string, role:string, text?:string, finish?:string, completedAt?:number}>} messages
 *   读回得到的会话消息。
 * @param {object} options
 * @param {string} options.text 本次发送的文本。
 * @param {boolean} [options.commandMatch] 本次是否为斜杠命令（命令消息文本未必等于 text）。
 * @param {Set<string>} [options.knownMessageIds] 发送前已存在的消息 id，用于识别新写入的用户消息。
 */
export function classifySendFailure(messages, { text, commandMatch = false, knownMessageIds = new Set() }) {
  const list = messages ?? []
  let latestUserIndex = -1
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i]
    if (message.role !== "user") continue
    if (knownMessageIds.has(message.id)) continue
    if (!commandMatch && message.text !== text) continue
    latestUserIndex = i
    break
  }
  const persisted = latestUserIndex >= 0
  const recovered = persisted && list.slice(latestUserIndex + 1).some((message) =>
    message.role === "assistant" && message.finish === "stop" && message.completedAt && message.text?.trim())
  return { latestUserIndex, persisted, recovered, needsReplySync: persisted && !recovered }
}
