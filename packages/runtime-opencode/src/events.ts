/**
 * OpenCode 原始事件 → NodeX 内部事件的翻译层。
 *
 * 图谱层（apps/api）只消费这里定义的内部事件，不再直接认识 OpenCode 的事件名，
 * 以便未来替换运行时或适配 OpenCode 2.x（2.x 复用同一批内部事件，只换翻译实现）。
 *
 * 关键语义（改动前 server.ts 内联解析里同样成立，必须原样保留）：
 *  - 会话归属：`sessionID ?? info.sessionID ?? part.sessionID`；
 *  - `message.updated` / `message.part.updated` 先登记角色与 part 类型，
 *    `message.part.delta` 再查（有先后顺序依赖）；
 *  - 只处理 assistant 角色的 delta，只认 text / reasoning。
 */

/** 会话状态三态（OpenCode `SessionStatus` 的归一化形态）。 */
export type RuntimeSessionStatus = "idle" | "retry" | "busy"

/** NodeX 内部事件；全部带 sessionId，便于订阅方按会话过滤。 */
export type NodexEvent =
  | { type: "session-status"; sessionId: string; status: RuntimeSessionStatus }
  | { type: "question"; sessionId: string; request: unknown }
  | {
      type: "tool"
      sessionId: string
      name: string | undefined
      status: "running" | "error"
      error: string | undefined
    }
  | { type: "text-delta"; sessionId: string; text: string }
  | { type: "thinking-delta"; sessionId: string; text: string }

/** 运行时原始事件（OpenCode 事件名 + properties）。 */
export interface RawRuntimeEvent {
  type: string
  properties?: unknown
}

/** 归属判定：session id 可能落在顶层、info 或 part 上。 */
export function rawSessionId(props: any): string | undefined {
  return props?.sessionID ?? props?.info?.sessionID ?? props?.part?.sessionID
}

/** 角色 / part 类型登记表的上限，避免长驻进程无限增长。 */
const PART_STATE_CAP = 4096

function remember(map: Map<string, string>, key: string, value: string): void {
  if (!key || !value) return
  map.delete(key)
  map.set(key, value)
  if (map.size > PART_STATE_CAP) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
}

/**
 * 创建有状态翻译器：维护 messageID→role 与 partID→type，
 * 供 `message.part.delta` 判定角色与 part 类型（未知默认 text）。
 */
export function createEventTranslator() {
  const messageRoles = new Map<string, string>()
  const partTypes = new Map<string, string>()

  function translate(event: RawRuntimeEvent): NodexEvent[] {
    const props = (event.properties ?? {}) as any
    switch (event.type) {
      case "session.status": {
        const sessionId = rawSessionId(props)
        const status = props?.status?.type
        if (!sessionId || (status !== "idle" && status !== "retry" && status !== "busy")) return []
        return [{ type: "session-status", sessionId, status }]
      }
      case "question.asked": {
        const sessionId = rawSessionId(props)
        if (!sessionId) return []
        return [{ type: "question", sessionId, request: props }]
      }
      case "message.updated": {
        const info = props.info
        if (info?.id && info?.role) remember(messageRoles, info.id, info.role)
        return []
      }
      case "message.part.updated": {
        const part = props.part
        if (part?.id && part?.type) remember(partTypes, part.id, part.type)
        if (part?.type === "tool" && (part.state?.status === "running" || part.state?.status === "error")) {
          const sessionId = rawSessionId(props)
          if (!sessionId) return []
          return [{
            type: "tool",
            sessionId,
            name: part.tool,
            status: part.state.status,
            error: part.state.status === "error" ? String(part.state.error ?? "工具失败") : undefined,
          }]
        }
        return []
      }
      case "message.part.delta": {
        const sessionId = rawSessionId(props)
        const messageID = props.messageID
        if (!sessionId || !messageID || messageRoles.get(messageID) !== "assistant") return []
        const partType = partTypes.get(props.partID) ?? "text"
        if (partType !== "reasoning" && partType !== "text") return []
        if (typeof props.delta !== "string" || !props.delta) return []
        return [{ type: partType === "reasoning" ? "thinking-delta" : "text-delta", sessionId, text: props.delta }]
      }
      default:
        return []
    }
  }

  return { translate }
}

export type EventTranslator = ReturnType<typeof createEventTranslator>
