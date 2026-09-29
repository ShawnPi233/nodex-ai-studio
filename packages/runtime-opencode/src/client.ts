import { createOpencodeClient } from "@opencode-ai/sdk"
import { OpencodeRuntime, type OpencodeClientLike } from "./opencode-runtime.ts"

export interface ConnectOptions {
  baseUrl?: string
  username?: string
  password?: string
  model?: { providerID: string; modelID: string }
  onStreamError?: (error: unknown) => void
}

/**
 * 连接已有的 OpenCode Server。
 * NodeX 不负责安装或修改 OpenCode，只消费其 HTTP 接口。
 */
export function connectOpencode(options: ConnectOptions = {}) {
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:4096"
  const auth =
    options.username && options.password
      ? `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`
      : undefined

  const client = createOpencodeClient({
    baseUrl,
    fetch: auth
      ? (input: any, init: any = {}) => {
          // 与 SDK 默认 fetch 一致：禁用 Bun 的 5 分钟默认超时，
          // 否则等待用户回答 / 长输出时请求会被截断。
          const request = input instanceof Request ? input : new Request(input, init)
          if (auth) request.headers.set("Authorization", auth)
          request.timeout = false
          return globalThis.fetch(request)
        }
      : undefined,
  })

  const runtime = new OpencodeRuntime({
    client: client as unknown as OpencodeClientLike,
    model: options.model,
    onStreamError: options.onStreamError,
    baseUrl,
    authHeader: auth,
  })

  return { client, runtime, baseUrl }
}
