/**
 * AgentRuntime：NodeX 图谱层唯一依赖的运行时抽象。
 * OpenCode 只是第一个实现，未来可替换为其他编码代理或通用对话运行时。
 */

import type { NodexEvent } from "./events.ts"

export interface RuntimeSession {
  id: string
  title: string
  parentId?: string
  /** OpenCode 原生 revert 状态：该 messageID 及其之后的对话视为已撤销。 */
  revert?: { messageID?: string }
}

export interface RuntimeMessagePart {
  type: string
  text?: string
  /** tool part 的工具名，如 write / edit / bash / read */
  tool?: string
  /** tool part 的状态载荷（含 input / output / metadata） */
  state?: unknown
  /** file part 的元信息 */
  filename?: string
  mime?: string
  url?: string
}

export interface RuntimeTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface RuntimeMessage {
  id: string
  role: "user" | "assistant"
  parts: RuntimeMessagePart[]
  completedAt?: number
  finish?: string
  /** 该条助手消息的 token 统计；用于估算当前上下文用量 */
  tokens?: RuntimeTokens
}

export interface RuntimeQuestionRequest {
  id: string
  sessionID: string
  questions: Array<{
    question: string
    header: string
    options: Array<{ label: string; description: string }>
    multiple?: boolean
    custom?: boolean
  }>
}

/** 运行时可选模型（由运行时自身枚举，NodeX 不硬编码模型清单）。 */
export interface RuntimeModelInfo {
  providerID: string
  modelID: string
  /** 展示名，缺省时用 modelID */
  name?: string
  providerName?: string
  /** 该模型可选的推理强度变体（如 low / medium / high）。 */
  variants?: string[]
  /** OpenCode 配置里该模型（或 provider）默认的推理强度，如 high。 */
  defaultEffort?: string
}

export interface RuntimeAgentInfo {
  name: string
  mode: string
}

export interface RuntimeCommandInfo {
  name: string
  description?: string
  source?: "command" | "mcp" | "skill"
}

export interface PromptInput {
  sessionId: string
  text: string
  /**
   * 请求级系统提示，与当次用户消息一同发送。
   * 不进入用户文本 part（不影响可见对话），仅在模型侧追加为 system 段。
   */
  system?: string
  /** 结构化输出用 JSON Schema；不支持时由实现忽略并说明 */
  jsonSchema?: Record<string, unknown>
  /** 本次调用的模型覆盖；缺省时用运行时默认模型 */
  model?: { providerID: string; modelID: string }
  /** 本次调用的主 agent（例如 build / plan）。 */
  agent?: string
  /** 推理强度变体（模型 variants 之一，如 low / medium / high）。 */
  variant?: string
}

export interface RuntimeCapabilities {
  fork: boolean
  summarize: boolean
  children: boolean
  mcp: boolean
  structuredOutput: boolean
  shell: boolean
}

export interface AgentRuntime {
  readonly id: string
  readonly capabilities: RuntimeCapabilities

  health(): Promise<{ healthy: boolean; version: string }>

  /** 枚举运行时可用模型，供 UI 选择主模型 */
  listModels(): Promise<RuntimeModelInfo[]>

  /** 运行时配置的默认模型；未配置时由运行时自行选择。 */
  defaultModel(): Promise<{ providerID: string; modelID: string } | undefined>

  /** 枚举运行时允许用户选择的主 agent。 */
  listAgents(): Promise<RuntimeAgentInfo[]>

  /** 配置的默认主 agent；缺省时 OpenCode 使用 build。 */
  defaultAgent(): Promise<string | undefined>

  /** 运行时当前配置的可执行会话命令。 */
  listCommands(): Promise<RuntimeCommandInfo[]>

  /** 运行时权威的正在执行会话列表；未列出的会话视为闲置。 */
  sessionStatuses(): Promise<Record<string, { type: string }>>
  listQuestions(): Promise<RuntimeQuestionRequest[]>
  replyQuestion(requestId: string, answers: string[][]): Promise<void>
  rejectQuestion(requestId: string): Promise<void>

  createSession(input: { title?: string; parentId?: string }): Promise<RuntimeSession>
  listSessions(): Promise<RuntimeSession[]>
  getSession(id: string): Promise<RuntimeSession>
  children(id: string): Promise<RuntimeSession[]>
  deleteSession(id: string): Promise<boolean>

  messages(sessionId: string): Promise<RuntimeMessage[]>
  /**
   * 发送提示并等待回复。
   * 使用 jsonSchema 时，结构化结果同时出现在：
   *   - structuredOutput：已解析的对象（优先使用）
   *   - text：JSON 字符串（兼容只读文本的调用方）
   */
  prompt(input: PromptInput): Promise<{
    text: string
    structuredOutput?: unknown
    raw?: unknown
  }>

  command(input: { sessionId: string; name: string; arguments: string; model?: PromptInput["model"]; agent?: string; variant?: string }): Promise<{ text: string }>

  /** OpenCode 原生会话压缩，区别于 NodeX 图谱的摘要镜像。 */
  compact(sessionId: string, model: { providerID: string; modelID: string }): Promise<void>

  /**
   * 向会话注入一条「只存不回」的用户消息，作为派生节点的上下文种子。
   * 用于「勾选上下文导出新节点」的灵活 fork：写入成功但不触发模型生成，
   * 后续对话即可在该上下文上继续。
   */
  seed(sessionId: string, text: string): Promise<void>

  /** 会话级摘要：NodeX 用它生成 Portal 快照 */
  summarize(sessionId: string): Promise<string | null>
  /** 从某条消息派生平行分支 */
  fork(sessionId: string, messageId?: string): Promise<RuntimeSession>

  /** 撤销到最后一条用户消息之前（OpenCode 原生 revert）。 */
  revert(sessionId: string, messageId: string): Promise<void>
  /** 取消撤销，恢复被 revert 的消息。 */
  unrevert(sessionId: string): Promise<void>

  /**
   * 无状态一次性补全：在独立临时会话中执行并立即销毁。
   * 用于生成节点标题/类别/摘要等元数据，避免污染用户会话历史。
   *
   * 返回纯文本；使用 jsonSchema 时返回 JSON 字符串（优先取结构化结果）。
   */
  complete(input: {
    prompt: string
    system?: string
    jsonSchema?: Record<string, unknown>
    model?: { providerID: string; modelID: string }
  }): Promise<string>

  abort(sessionId: string): Promise<boolean>

  /**
   * 订阅运行时事件（已翻译为 NodeX 内部事件，见 events.ts）。
   * 多次调用共享同一上游连接；返回的函数只移除该订阅者。
   */
  subscribe(onEvent: (event: NodexEvent) => void): Promise<() => void>
}
