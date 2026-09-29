import { test, expect } from "bun:test"
import { OpencodeRuntime, isOpencodeVersionSupported } from "../src/opencode-runtime.ts"

/**
 * 契约测试：用真实 HTTP 假服务器跑一遍 NodeX 适配器依赖的端点，
 * 断言请求形状与解析结果。OpenCode 升级时这是第一道闸门。
 */
test("HTTP 契约：NodeX 依赖的端点与请求形状", async () => {
  const seen: Array<{ method: string; path: string; auth?: string; body?: unknown }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === "POST" && req.headers.get("content-type")?.includes("json")
        ? await req.json().catch(() => undefined)
        : undefined
      seen.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization") ?? undefined, body })
      if (url.pathname === "/global/health") return Response.json({ healthy: true, version: "1.17.20" })
      if (url.pathname === "/config") return Response.json({ model: "demo/alpha", default_agent: "plan" })
      if (url.pathname === "/config/providers") {
        return Response.json({ providers: [{ id: "demo", name: "Demo", models: {
          alpha: { name: "Alpha" },
          old: { name: "Old", status: "deprecated" },
          gamma: { name: "Gamma", variants: { low: {}, high: {} } },
        } }] })
      }
      if (url.pathname === "/agent") return Response.json([
        { name: "build", mode: "primary" }, { name: "hidden", mode: "primary", hidden: true },
      ])
      if (url.pathname === "/command") return Response.json([
        { name: "review", description: "r", source: "command" }, { name: "bad name", source: "command" },
      ])
      if (url.pathname === "/session/status") return Response.json({ ses_1: { type: "busy" } })
      if (url.pathname === "/question") return Response.json([{ id: "q1", sessionID: "ses_1", questions: [] }])
      if (/^\/question\/[^/]+\/(reply|reject)$/.test(url.pathname)) return Response.json(true)
      return Response.json({ error: "unknown" }, { status: 404 })
    },
  })
  const baseUrl = `http://127.0.0.1:${server.port}`
  const client = { session: {} as never, event: {} as never } as never
  const rt = new OpencodeRuntime({ client, baseUrl, authHeader: "Basic xyz" })
  try {
    expect(await rt.health()).toEqual({ healthy: true, version: "1.17.20" })
    const models = await rt.listModels()
    expect(models.map((m) => `${m.providerID}/${m.modelID}`)).toEqual(["demo/alpha", "demo/gamma"])
    expect(models.find((m) => m.modelID === "gamma")?.variants).toEqual(["low", "high"])
    expect(await rt.defaultModel()).toEqual({ providerID: "demo", modelID: "alpha" })
    expect(await rt.defaultAgent()).toBe("plan")
    expect(await rt.listAgents()).toEqual([{ name: "build", mode: "primary" }])
    expect(await rt.listCommands()).toEqual([{ name: "review", description: "r", source: "command" }])
    expect(await rt.sessionStatuses()).toEqual({ ses_1: { type: "busy" } })
    expect((await rt.listQuestions())[0].id).toBe("q1")
    await rt.replyQuestion("q1", [["A"]])
    await rt.rejectQuestion("q1")
    expect(seen.every((entry) => entry.auth === "Basic xyz")).toBe(true)
    expect(seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual(expect.arrayContaining([
      "GET /global/health", "GET /config", "GET /config/providers", "GET /agent",
      "GET /command", "GET /session/status", "GET /question",
      "POST /question/q1/reply", "POST /question/q1/reject",
    ]))
    expect(seen.find((entry) => entry.path === "/question/q1/reply")?.body).toEqual({ answers: [["A"]] })
  } finally {
    server.stop(true)
  }
})

test("版本区间判断", () => {
  expect(isOpencodeVersionSupported("1.17.20")).toBe(true)
  expect(isOpencodeVersionSupported("1.18.4")).toBe(true)
  expect(isOpencodeVersionSupported("1.16.9")).toBe(false)
  expect(isOpencodeVersionSupported("2.0.0")).toBe(false)
  expect(isOpencodeVersionSupported("unknown")).toBe(false)
})
