import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * NodeX 的本地 AI 配置（摘要 / 元数据等轻量生成能力）。
 *
 * 安全约定：API Key 只存在于本地数据目录的 `graph.json`（`runs/` 已 gitignore）
 * 或用户自己的 OpenCode 配置里，绝不写入源码或仓库。接口只返回脱敏值。
 */
export interface AiSettings {
  baseUrl?: string
  apiKey?: string
  model?: string
  systemPrompt?: string
}

export const DEFAULT_AI_MODEL = "gpt-4o-mini"
export const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1"
export const DEFAULT_AI_SYSTEM =
  "你是知识图谱的信息抽取器。根据内容生成节点元数据。" +
  "只输出 JSON，不要解释，不要 Markdown 代码块。"

export interface ResolvedAi {
  baseUrl: string
  apiKey: string
  model: string
  systemPrompt: string
  apiKeySource: "settings" | "env" | "opencode" | "none"
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/** 读取用户 OpenCode 配置里 provider 的 baseURL/apiKey（运行时读取，不落库、不进仓库）。 */
export function readOpencodeProviderKey(baseUrl?: string): { baseUrl?: string; apiKey?: string } | null {
  const candidates = [
    process.env.OPENCODE_CONFIG,
    process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME, "opencode/opencode.json") : undefined,
    process.env.HOME ? resolve(process.env.HOME, ".config/opencode/opencode.json") : undefined,
  ].filter((value): value is string => Boolean(value))

  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue
      const data = JSON.parse(readFileSync(path, "utf8")) as { provider?: Record<string, { options?: { baseURL?: string; apiKey?: string } }> }
      const entries = Object.values(data?.provider ?? {})
      const match = baseUrl ? entries.find((p) => p?.options?.baseURL === baseUrl) : undefined
      const chosen = match ?? entries.find((p) => p?.options?.apiKey && p?.options?.baseURL)
      if (chosen?.options?.apiKey) return { baseUrl: chosen.options.baseURL, apiKey: chosen.options.apiKey }
    } catch {
      // 配置缺失或格式异常时忽略，继续下一个候选路径
    }
  }
  return null
}

/**
 * 解析生效的 AI 配置。
 * 优先级：NodeX 设置 > 环境变量 > 用户 OpenCode 配置（仅补足 API Key）。
 */
export function resolveAiSettings(settings: AiSettings = {}, options: { allowOpencodeFallback?: boolean } = {}): ResolvedAi {
  const settingBase = settings.baseUrl?.trim()
  const envBase = process.env.NODEX_AI_BASE_URL?.trim()
  const explicitBase = [settingBase, envBase].find((value) => value && isHttpUrl(value))
  let baseUrl = explicitBase ?? DEFAULT_AI_BASE_URL

  const settingKey = settings.apiKey?.trim()
  const envKey = process.env.NODEX_AI_API_KEY?.trim()
  let apiKey = settingKey || envKey || ""
  let apiKeySource: ResolvedAi["apiKeySource"] = settingKey ? "settings" : envKey ? "env" : "none"

  if (!apiKey && (options.allowOpencodeFallback ?? true)) {
    const fromConfig = readOpencodeProviderKey(explicitBase)
    if (fromConfig?.apiKey) {
      apiKey = fromConfig.apiKey
      apiKeySource = "opencode"
      // 借用 OpenCode 的 Key 时，必须一并跟随它配套的 baseURL：
      // 否则会变成「OpenAI 地址 + 非 OpenAI 模型/密钥」，请求要挂到超时才回退。
      if (!explicitBase && fromConfig.baseUrl) baseUrl = fromConfig.baseUrl
    }
  }

  const model = settings.model?.trim() || process.env.NODEX_AI_MODEL?.trim() || DEFAULT_AI_MODEL
  const systemPrompt = settings.systemPrompt?.trim() || DEFAULT_AI_SYSTEM
  return { baseUrl, apiKey, model, systemPrompt, apiKeySource }
}

export function maskApiKey(key: string): string {
  if (!key) return ""
  if (key.length <= 10) return "••••••"
  return `${key.slice(0, 4)}••••••${key.slice(-4)}`
}

/** 调用 OpenAI 兼容的 `/chat/completions`；密钥仅用于请求头，不记录日志。 */
export async function aiChat(
  resolved: ResolvedAi,
  input: { prompt: string; system?: string; timeoutMs?: number },
): Promise<string> {
  if (!resolved.apiKey) throw new Error("未配置 AI API Key，请在「AI 设置」中填写")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 90000)
  try {
    const res = await fetch(`${resolved.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${resolved.apiKey}` },
      body: JSON.stringify({
        model: resolved.model,
        messages: [
          { role: "system", content: input.system ?? resolved.systemPrompt },
          { role: "user", content: input.prompt },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      throw new Error(`AI 请求失败 ${res.status}: ${detail.slice(0, 300)}`)
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = data?.choices?.[0]?.message?.content
    if (typeof content === "string" && content.trim()) return content
    if (Array.isArray(content)) {
      const joined = content.map((part) => (typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : "")).join("")
      if (joined.trim()) return joined
    }
    throw new Error("AI 返回空内容")
  } finally {
    clearTimeout(timer)
  }
}
