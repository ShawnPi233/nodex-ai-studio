/**
 * 运行时状态判定（纯函数，便于单测）。
 *
 * OpenCode 的 `SessionStatus` 形态为 `idle | retry | busy`。
 * `retry`（重试中）必须视为活跃：否则重试期间会被判空闲，
 * 导致排队消息被续发或触发自动标题。
 */

/** OpenCode `SessionStatus` 的最小形态。 */
export interface SessionStatusLike {
  type?: string
}

/** 会话是否处于活跃态：仅 `busy` / `retry` 为活跃，`idle` 与未知都不算。 */
export function isSessionActive(status: SessionStatusLike | null | undefined): boolean {
  return status?.type === "busy" || status?.type === "retry"
}
