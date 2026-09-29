import type {
  AgentRuntime,
  PromptInput,
  RuntimeCapabilities,
  RuntimeAgentInfo,
  RuntimeCommandInfo,
  RuntimeMessage,
  RuntimeModelInfo,
  RuntimeQuestionRequest,
  RuntimeSession,
} from "./runtime.ts"
import { createEventTranslator, type NodexEvent } from "./events.ts"

/**
 * NodeX 适配器依赖的 OpenCode 版本区间（含端点与行为假设）。
 * 升级前应通过契约测试；超出区间时 /health 会标记 unsupported。
 */
export const OPENCODE_SUPPORTED_RANGE = { min: "1.17.0", maxExclusive: "2.0.0" } as const

/** 判断 OpenCode 版本是否在支持区间内（形如 1.17.20）。 */
export function isOpencodeVersionSupported(version: string): boolean {
  const parts = String(version).trim().split(".").map((n) => Number.parseInt(n, 10))
  const major = parts[0]
  const minor = parts[1]
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false
  const [minMajor, minMinor] = OPENCODE_SUPPORTED_RANGE.min.split(".").map(Number)
  const maxMajor = Number(OPENCODE_SUPPORTED_RANGE.maxExclusive.split(".")[0])
  return (major > minMajor || (major === minMajor && minor >= minMinor)) && major < maxMajor
}

/** 只依赖 SDK 暴露的最小 client 形状，便于测试注入。 */
export interface OpencodeClientLike {
  /** SDK 1.18 起 global 只暴露 event()；健康检查走 HTTP */
  global?: Record<string, unknown>
  session: {
    create(args: { body: { parentID?: string; title?: string } }): Promise<{ data?: any }>
    list(): Promise<{ data?: any[] }>
    get(args: { path: { id: string } }): Promise<{ data?: any }>
    children(args: { path: { id: string } }): Promise<{ data?: any[] }>
    delete(args: { path: { id: string } }): Promise<{ data?: boolean }>
    messages(args: { path: { id: string } }): Promise<{ data?: any[] }>
    prompt(args: { path: { id: string }; body: any }): Promise<{ data?: any }>
    command(args: { path: { id: string }; body: any }): Promise<{ data?: any }>
    summarize(args: { path: { id: string }; body: any }): Promise<{ data?: any }>
    fork(args: { path: { id: string }; body: { messageID?: string } }): Promise<{ data?: any }>
    revert(args: { path: { id: string }; body: { messageID: string } }): Promise<{ data?: any }>
    unrevert(args: { path: { id: string } }): Promise<{ data?: any }>
    abort(args: { path: { id: string } }): Promise<{ data?: boolean }>
  }
  event: {
    subscribe(args?: { signal?: AbortSignal }): Promise<{ stream: AsyncIterable<any> }>
  }
}

/** `/config/providers` 的响应形状（仅取 NodeX 用到的字段）。 */
interface OpencodeProviderModel {
  name?: string
  status?: string
  variants?: Record<string, unknown>
  /** 模型级配置，含默认推理强度 options.reasoningEffort */
  options?: Record<string, unknown>
}
interface OpencodeProvider {
  id?: string
  name?: string
  models?: Record<string, OpencodeProviderModel>
  /** provider 级配置，模型未覆盖时的默认推理强度 */
  options?: Record<string, unknown>
}
interface OpencodeProvidersResponse {
  providers?: OpencodeProvider[]
}

export interface OpencodeRuntimeOptions {
  client: OpencodeClientLike
  /** 摘要与默认对话使用的模型 */
  model?: { providerID: string; modelID: string }
  /** 事件流重连基线，避免断线丢事件 */
  onStreamError?: (error: unknown) => void
  /** 健康检查与事件流使用的 base URL；缺省时 health 返回 unknown */
  baseUrl?: string
  /** Basic 认证头，仅在直连 HTTP 时使用 */
  authHeader?: string
}

/** 读取配置里的 reasoningEffort，只接受非空字符串。 */
function asEffort(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function toSession(raw: any): RuntimeSession {
  const session: RuntimeSession = {
    id: raw.id,
    title: raw.title ?? "",
    parentId: raw.parentID ?? raw.parentId,
  }
  if (raw.revert?.messageID) session.revert = { messageID: raw.revert.messageID }
  return session
}

function toMessages(raw: any[]): RuntimeMessage[] {
  return raw.map((entry) => {
    const info = entry?.info ?? entry
    const parts = entry?.parts ?? info?.parts ?? []
    const tokens = info?.tokens
    return {
      id: info?.id ?? "",
      role: info?.role === "user" ? "user" : "assistant",
      completedAt: typeof info?.time?.completed === "number" ? info.time.completed : undefined,
      finish: typeof info?.finish === "string" ? info.finish : undefined,
      ...(tokens
        ? {
            tokens: {
              input: Number(tokens.input) || 0,
              output: Number(tokens.output) || 0,
              reasoning: Number(tokens.reasoning) || 0,
              cacheRead: Number(tokens.cache?.read) || 0,
              cacheWrite: Number(tokens.cache?.write) || 0,
            },
          }
        : {}),
      parts: parts.map((p: any) => ({
        type: p?.type ?? "unknown",
        text: typeof p?.text === "string" ? p.text : undefined,
        tool: typeof p?.tool === "string" ? p.tool : undefined,
        state: p?.state ?? undefined,
        filename: p?.filename ?? undefined,
        mime: p?.mime ?? undefined,
        url: p?.url ?? undefined,
      })),
    }
  })
}

/** 从消息数组中拼接纯文本，供 NodeX 建立自己的索引。 */
export function messagesToText(messages: RuntimeMessage[]): string {
  return messages
    .map((m) => m.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n"))
    .filter(Boolean)
    .join("\n\n")
}

export class OpencodeRuntime implements AgentRuntime {
  readonly id = "opencode"
  readonly capabilities: RuntimeCapabilities = {
    fork: true,
    summarize: true,
    children: true,
    mcp: true,
    structuredOutput: true,
    shell: true,
  }

  constructor(private readonly options: OpencodeRuntimeOptions) {}

  /** 单一上游事件连接 + 扇出：见 subscribe()。 */
  private readonly translator = createEventTranslator()
  private readonly subscribers = new Set<(event: NodexEvent) => void>()
  private upstream: { close: () => void } | null = null
  private upstreamReady: Promise<void> | null = null

  private get client(): OpencodeClientLike {
    return this.options.client
  }

  /**
   * 健康检查走 HTTP /global/health。
   * SDK 1.18 的 client.global 只暴露 event()，不再提供 health()。
   */
  async health() {
    const base = this.options.baseUrl
    if (!base) return { healthy: false, version: "unknown" }
    try {
      const res = await fetch(`${base}/global/health`, {
        headers: this.options.authHeader ? { Authorization: this.options.authHeader } : undefined,
      })
      if (!res.ok) return { healthy: false, version: "unknown" }
      return (await res.json()) as { healthy: boolean; version: string }
    } catch {
      return { healthy: false, version: "unknown" }
    }
  }

  /**
   * 与 TUI 的模型对话框一致，枚举当前连接的 provider，而非全量模型目录。
   */
  async listModels(): Promise<RuntimeModelInfo[]> {
    const base = this.options.baseUrl
    if (!base) return []
    try {
      const res = await fetch(`${base}/config/providers`, {
        headers: this.options.authHeader ? { Authorization: this.options.authHeader } : undefined,
      })
      if (!res.ok) return []
      const config = (await res.json()) as OpencodeProvidersResponse
      const providers = config.providers ?? []
      const models: RuntimeModelInfo[] = []
      for (const provider of providers) {
        const providerID = provider.id
        if (typeof providerID !== "string" || !providerID) continue
        const providerName = provider.name ?? providerID
        const providerEffort = asEffort(provider.options?.reasoningEffort)
        const list = provider.models ?? {}
        for (const [modelID, model] of Object.entries(list)) {
          if (model?.status === "deprecated") continue
          const variants = model?.variants && typeof model.variants === "object"
            ? Object.keys(model.variants)
            : undefined
          const defaultEffort = asEffort(model?.options?.reasoningEffort) ?? providerEffort
          models.push({
            providerID,
            modelID,
            name: model?.name ?? modelID,
            providerName,
            ...(variants && variants.length ? { variants } : {}),
            ...(defaultEffort ? { defaultEffort } : {}),
          })
        }
      }
      const configured = await this.defaultModel()
      if (configured && !models.some((item) => item.providerID === configured.providerID && item.modelID === configured.modelID)) {
        models.push({ ...configured, name: configured.modelID, providerName: providers.find((item) => item.id === configured.providerID)?.name ?? configured.providerID })
      }
      models.sort(
        (a, b) =>
          a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID),
      )
      return models
    } catch {
      return []
    }
  }

  async defaultModel(): Promise<{ providerID: string; modelID: string } | undefined> {
    if (!this.options.baseUrl) return undefined
    try {
      const res = await fetch(`${this.options.baseUrl}/config`, {
        headers: this.options.authHeader ? { Authorization: this.options.authHeader } : undefined,
        signal: AbortSignal.timeout(4000),
      })
      if (!res.ok) return undefined
      const config = await res.json() as { model?: string }
      if (!config.model) return undefined
      const [providerID, ...modelParts] = config.model.split("/")
      const modelID = modelParts.join("/")
      return providerID && modelID ? { providerID, modelID } : undefined
    } catch {
      return undefined
    }
  }

  async listAgents(): Promise<RuntimeAgentInfo[]> {
    if (!this.options.baseUrl) return []
    const res = await fetch(`${this.options.baseUrl}/agent`, {
      headers: this.options.authHeader ? { Authorization: this.options.authHeader } : undefined,
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) throw new Error(`opencode: 读取 agent 失败 ${res.status}`)
    const agents = await res.json() as Array<{ name?: string; mode?: string; hidden?: boolean }>
    return agents.filter((agent) => agent.name && agent.mode === "primary" && !agent.hidden)
      .map((agent) => ({ name: agent.name!, mode: agent.mode! }))
  }

  async defaultAgent(): Promise<string | undefined> {
    if (!this.options.baseUrl) return undefined
    try {
      const res = await fetch(`${this.options.baseUrl}/config`, {
        headers: this.options.authHeader ? { Authorization: this.options.authHeader } : undefined,
        signal: AbortSignal.timeout(4000),
      })
      if (!res.ok) return undefined
      const config = await res.json() as { default_agent?: string }
      return config.default_agent || undefined
    } catch {
      return undefined
    }
  }

  async listCommands(): Promise<RuntimeCommandInfo[]> {
    if (!this.options.baseUrl) return []
    const res = await fetch(`${this.options.baseUrl}/command`, {
      headers: this.options.authHeader ? { Authorization: this.options.authHeader } : undefined,
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) throw new Error(`opencode: 读取命令失败 ${res.status}`)
    const commands = await res.json() as Array<{ name?: string; description?: string; source?: string }>
    return commands.filter((item) => typeof item.name === "string" && /^[a-zA-Z][\w.:-]*$/.test(item.name))
      .map((item) => ({
        name: item.name!,
        description: typeof item.description === "string" ? item.description : undefined,
        ...(item.source === "command" || item.source === "skill" || item.source === "mcp" ? { source: item.source } : {}),
      }))
  }

  async sessionStatuses(): Promise<Record<string, { type: string }>> {
    if (!this.options.baseUrl) throw new Error("opencode: 缺少运行时地址")
    const res = await fetch(`${this.options.baseUrl}/session/status`, {
      headers: this.options.authHeader ? { Authorization: this.options.authHeader } : undefined,
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) throw new Error(`opencode: 读取会话状态失败 ${res.status}`)
    return await res.json() as Record<string, { type: string }>
  }

  async listQuestions(): Promise<RuntimeQuestionRequest[]> {
    if (!this.options.baseUrl) throw new Error("opencode: 缺少运行时地址")
    const res = await fetch(`${this.options.baseUrl}/question`, {
      headers: this.options.authHeader ? { Authorization: this.options.authHeader } : undefined,
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) throw new Error(`opencode: 读取待回答问题失败 ${res.status}`)
    return await res.json() as RuntimeQuestionRequest[]
  }

  async replyQuestion(requestId: string, answers: string[][]): Promise<void> {
    if (!this.options.baseUrl) throw new Error("opencode: 缺少运行时地址")
    const res = await fetch(`${this.options.baseUrl}/question/${encodeURIComponent(requestId)}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.options.authHeader ? { Authorization: this.options.authHeader } : {}) },
      body: JSON.stringify({ answers }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`opencode: 提交回答失败 ${res.status}`)
  }

  async rejectQuestion(requestId: string): Promise<void> {
    if (!this.options.baseUrl) throw new Error("opencode: 缺少运行时地址")
    const res = await fetch(`${this.options.baseUrl}/question/${encodeURIComponent(requestId)}/reject`, {
      method: "POST",
      headers: this.options.authHeader ? { Authorization: this.options.authHeader } : undefined,
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`opencode: 拒绝回答失败 ${res.status}`)
  }

  async createSession(input: { title?: string; parentId?: string }) {
    const res = await this.client.session.create({
      body: { title: input.title, parentID: input.parentId },
    })
    if (!res.data) throw new Error("opencode: 创建会话未返回数据")
    return toSession(res.data)
  }

  async listSessions() {
    const res = await this.client.session.list()
    return (res.data ?? []).map(toSession)
  }

  async getSession(id: string) {
    const res = await this.client.session.get({ path: { id } })
    if (!res.data) throw new Error(`opencode: 会话不存在 ${id}`)
    return toSession(res.data)
  }

  async children(id: string) {
    const res = await this.client.session.children({ path: { id } })
    return (res.data ?? []).map(toSession)
  }

  async deleteSession(id: string) {
    const res = await this.client.session.delete({ path: { id } })
    return res.data ?? false
  }

  async messages(sessionId: string) {
    const res = await this.client.session.messages({ path: { id: sessionId } })
    return toMessages(res.data ?? [])
  }

  async prompt(input: PromptInput) {
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: input.text }],
    }
    const model = input.model ?? this.options.model
    if (model) body.model = model
    if (input.agent) body.agent = input.agent
    if (input.variant) body.variant = input.variant
    if (input.system) body.system = input.system
    if (input.jsonSchema) {
      body.format = { type: "json_schema", schema: input.jsonSchema }
    }

    const res = (await this.client.session.prompt({
      path: { id: input.sessionId },
      body,
    })) as any
    const data = res?.data
    const info = data?.info ?? data
    const parts = data?.parts ?? info?.parts ?? []

    // SDK 在 throwOnError=false 时把 HTTP 错误放在顶层 error 字段。
    // 必须显式抛出，否则失败会被当成空回复静默吞掉。
    const sdkError = res?.error
    if (sdkError) {
      throw new Error(
        `opencode: 提示失败 ${sdkError.name ?? ""} ${sdkError.data?.message ?? JSON.stringify(sdkError)}`,
      )
    }

    // 回复体内部的错误（如结构化输出校验失败、上游 provider 报错）
    if (info?.error) {
      const message = info.error.data?.message ?? info.error.message ?? JSON.stringify(info.error)
      throw new Error(`opencode: 提示失败 ${info.error.name ?? ""} ${message}`)
    }

    // 结构化输出：模型不通过 text part 返回，而是放在 info.structured，
    // 同时以 StructuredOutput 工具调用出现在 parts 中。
    // 若不提取这两处，json_schema 请求会被误判为「空正文」。
    const structured =
      info?.structured ??
      parts.find((p: any) => p?.type === "tool" && p?.tool === "StructuredOutput")?.state
        ?.input ??
      undefined

    const text = parts
      .filter((p: any) => typeof p?.text === "string")
      .map((p: any) => p.text)
      .join("\n")

    // 请求了结构化输出且拿到结果时，结构化结果优先：部分模型会先输出一段旁白
    // text part 再给出 StructuredOutput，若优先正文就会丢掉 JSON。
    // 未请求结构化输出时仍以正文为准（见下方「有正文时优先正文」用例）。
    const finalText = input.jsonSchema && structured !== undefined
      ? JSON.stringify(structured)
      : (text || (structured !== undefined ? JSON.stringify(structured) : ""))

    // 既无错误也无任何内容，视为异常，避免静默返回空字符串
    if (!finalText) {
      throw new Error("opencode: 提示返回了空正文")
    }

    return { text: finalText, structuredOutput: structured, raw: data }
  }

  async command(input: { sessionId: string; name: string; arguments: string; model?: PromptInput["model"]; agent?: string; variant?: string }) {
    const body: Record<string, unknown> = { command: input.name, arguments: input.arguments }
    if (input.model) body.model = `${input.model.providerID}/${input.model.modelID}`
    if (input.agent) body.agent = input.agent
    if (input.variant) body.variant = input.variant
    const res = await this.client.session.command({ path: { id: input.sessionId }, body }) as any
    if (res?.error) throw new Error(`opencode: 命令失败 ${res.error.data?.message ?? JSON.stringify(res.error)}`)
    const info = res?.data?.info
    if (info?.error) throw new Error(`opencode: 命令失败 ${info.error.data?.message ?? info.error.message ?? info.error.name}`)
    if (!res?.data) throw new Error("opencode: 命令未返回结果")
    return { text: (res.data.parts ?? []).filter((part: any) => part.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n") }
  }

  async compact(sessionId: string, model: { providerID: string; modelID: string }) {
    const res = await this.client.session.summarize({ path: { id: sessionId }, body: model }) as any
    if (res?.error) throw new Error(`opencode: 压缩失败 ${res.error.data?.message ?? JSON.stringify(res.error)}`)
    if (res?.data !== true) throw new Error("opencode: 压缩未成功")
  }

  /**
   * noReply 注入：OpenCode 会存下这条 user 消息但不生成回复。
   * 这是「勾选上下文导出新节点」的干净种子——不消耗模型额度，也不留空回复。
   */
  async seed(sessionId: string, text: string) {
    const res = (await this.client.session.prompt({
      path: { id: sessionId },
      body: { noReply: true, parts: [{ type: "text", text }] },
    })) as any
    const sdkError = res?.error
    if (sdkError) {
      throw new Error(
        `opencode: 注入上下文失败 ${sdkError.data?.message ?? JSON.stringify(sdkError)}`,
      )
    }
  }

  async summarize(sessionId: string) {
    if (!this.options.model) return null
    await this.client.session.summarize({
      path: { id: sessionId },
      body: this.options.model,
    })
    // OpenCode 将摘要写回会话；NodeX 重新读取消息并抽取最后一条摘要文本
    const messages = await this.messages(sessionId)
    const summary = messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n"))
      .filter(Boolean)
      .at(-1)
    return summary || null
  }

  async fork(sessionId: string, messageId?: string) {
    const res = await this.client.session.fork({
      path: { id: sessionId },
      body: { messageID: messageId },
    })
    if (!res.data) throw new Error("opencode: fork 未返回会话")
    return toSession(res.data)
  }

  /** 撤销到最后一条用户消息之前（OpenCode 原生 revert）。 */
  async revert(sessionId: string, messageId: string) {
    const res = await this.client.session.revert({
      path: { id: sessionId },
      body: { messageID: messageId },
    }) as any
    if (res?.error) throw new Error(`opencode: 撤销失败 ${res.error.data?.message ?? JSON.stringify(res.error)}`)
  }

  /** 取消撤销，恢复被 revert 的消息。 */
  async unrevert(sessionId: string) {
    const res = await this.client.session.unrevert({ path: { id: sessionId } }) as any
    if (res?.error) throw new Error(`opencode: 恢复失败 ${res.error.data?.message ?? JSON.stringify(res.error)}`)
  }

  /**
   * 无状态一次性补全。
   * 创建临时会话 → 取回复（system 与用户文本在同一次 prompt 中发送）→ 无论成败都销毁会话，
   * 保证元数据生成不会污染用户的会话历史。
   */
  async complete(input: {
    prompt: string
    system?: string
    jsonSchema?: Record<string, unknown>
    model?: { providerID: string; modelID: string }
  }): Promise<string> {
    const session = await this.createSession({ title: "__nodex_meta__" })
    try {
      const result = await this.prompt({
        sessionId: session.id,
        text: input.prompt,
        system: input.system,
        jsonSchema: input.jsonSchema,
        model: input.model,
      })
      return result.text
    } finally {
      await this.deleteSession(session.id).catch(() => false)
    }
  }

  async abort(sessionId: string) {
    const res = await this.client.session.abort({ path: { id: sessionId } }) as any
    if (res?.error) throw new Error(`opencode: 停止失败 ${res.error.data?.message ?? JSON.stringify(res.error)}`)
    return res.data === true
  }

  /**
   * 订阅事件流：内部只维持**一条**上游 SSE，把翻译后的 NodeX 内部事件扇出给所有订阅者。
   * SDK 的 SSE 客户端会无限重连且不返回取消句柄，因此由 NodeX 持有
   * AbortController；订阅者全部退订时才真正关闭连接。
   */
  async subscribe(onEvent: (event: NodexEvent) => void): Promise<() => void> {
    this.subscribers.add(onEvent)
    await this.ensureUpstream()
    return () => {
      this.subscribers.delete(onEvent)
      if (this.subscribers.size === 0) this.closeUpstream()
    }
  }

  private ensureUpstream(): Promise<void> {
    if (this.upstream) return Promise.resolve()
    if (!this.upstreamReady) this.upstreamReady = this.startUpstream()
    return this.upstreamReady
  }

  private async startUpstream(): Promise<void> {
    const controller = new AbortController()
    try {
      const events = (await this.client.event.subscribe({ signal: controller.signal })) as { stream: AsyncIterable<any> }
      this.upstream = { close: () => controller.abort() }
      void this.pump(events.stream, controller)
    } catch (error) {
      // 建立连接失败：清掉 memo，让下次 subscribe 重试；不向调用方抛出。
      this.upstreamReady = null
      this.options.onStreamError?.(error)
    }
  }

  private async pump(stream: AsyncIterable<any>, controller: AbortController): Promise<void> {
    try {
      for await (const event of stream) {
        if (controller.signal.aborted) break
        const raw = event as any
        const type = raw?.type ?? raw?.event ?? "unknown"
        const properties = raw?.properties ?? raw?.data?.properties
        for (const translated of this.translator.translate({ type, properties })) {
          for (const subscriber of [...this.subscribers]) {
            try { subscriber(translated) } catch { /* 单个订阅者出错不影响其它订阅者 */ }
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) this.options.onStreamError?.(error)
    } finally {
      // 流意外结束（非本次主动关闭）时允许下次 subscribe 重新建连。
      if (this.upstream && !controller.signal.aborted) {
        this.upstream = null
        this.upstreamReady = null
      }
    }
  }

  private closeUpstream(): void {
    this.upstream?.close()
    this.upstream = null
    this.upstreamReady = null
  }
}
