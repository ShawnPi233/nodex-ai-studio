import type { AgentRuntime } from "@nodex/runtime-opencode"
import { aiChat, type ResolvedAi } from "./ai.ts"

export interface NodeMetadata {
  title: string
  category: string
  categories: string[]
  tags: string[]
  summary: string
}

/** AI 生成的元数据结构；字段越少越稳定，标签限定为字符串数组。 */
export const METADATA_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "不超过 12 个字的简洁标题，中文" },
    categories: { type: "array", items: { type: "string" }, description: "0-4 个相关类别，每个 2-6 个字，中文" },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "2-4 个关键词标签，每个 2-6 个字",
    },
    summary: { type: "string", description: "不超过 120 字的内容摘要，中文" },
  },
  required: ["title", "categories", "summary"],
} as const

const SYSTEM =
  "你是知识图谱的信息抽取器。根据对话内容生成节点元数据。" +
  "只输出 JSON，不要解释，不要 Markdown 代码块。"

/** 从模型回复中稳健地提取 JSON（容忍代码块与多余文本）。 */
export function parseMetadata(raw: string): NodeMetadata | null {
  if (!raw) return null
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start < 0 || end <= start) return null

  let parsed: any
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null

  const title = typeof parsed.title === "string" ? parsed.title.trim() : ""
  const values = Array.isArray(parsed.categories) ? parsed.categories : [parsed.category]
  const categories = [...new Set(values.filter((value: unknown): value is string => typeof value === "string").map((value: string) => value.trim()).filter(Boolean))]
  const category = categories[0] ?? ""
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : ""
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.filter((t: unknown): t is string => typeof t === "string").map((t: string) => t.trim()).filter(Boolean)
    : []

  if (!title && !category && !summary) return null
  return { title, category, categories, tags, summary }
}

/**
 * 依据节点已有对话内容生成标题/类别/标签/摘要。
 * 使用无状态补全会话，不污染用户会话。
 */
export async function generateMetadata(
  runtime: AgentRuntime,
  content: string,
  hint?: {
    currentTitle?: string
    currentCategory?: string
    model?: { providerID: string; modelID: string }
  },
): Promise<NodeMetadata | null> {
  const excerpt = content.trim().slice(0, 6000)
  if (!excerpt) return null

  const prompt = [
    hint?.currentTitle ? `当前标题（可优化）：${hint.currentTitle}` : "",
    hint?.currentCategory ? `当前类别（可优化）：${hint.currentCategory}` : "",
    "对话内容：",
    excerpt,
  ]
    .filter(Boolean)
    .join("\n")

  const raw = await runtime.complete({
    prompt,
    system: SYSTEM,
    jsonSchema: METADATA_SCHEMA as unknown as Record<string, unknown>,
    model: hint?.model,
  })
  return parseMetadata(raw)
}

/**
 * 用 NodeX 自己的直连模型生成元数据（笔记本摘要等）。
 * 不经过 OpenCode，因此可独立配置模型与 API Key。
 */
export async function generateMetadataWithAi(
  resolved: ResolvedAi,
  content: string,
  hint?: { currentTitle?: string; currentCategory?: string },
): Promise<NodeMetadata | null> {
  const excerpt = content.trim().slice(0, 6000)
  if (!excerpt) return null

  const prompt = [
    hint?.currentTitle ? `当前标题（可优化）：${hint.currentTitle}` : "",
    hint?.currentCategory ? `当前类别（可优化）：${hint.currentCategory}` : "",
    "内容：",
    excerpt,
    "",
    "请输出 JSON：title 为不超过 12 字的中文标题，summary 为不超过 120 字的中文摘要，categories 为 0-4 个 2-6 字中文类别。",
  ]
    .filter(Boolean)
    .join("\n")

  // 元数据是轻量任务：端点异常时快速失败，让上层及时回退到 OpenCode，
  // 而不是一直挂到 aiChat 的默认超时。
  const raw = await aiChat(resolved, { prompt, timeoutMs: 30000 })
  return parseMetadata(raw)
}
