import assert from "node:assert/strict"
import test from "node:test"
import { messagesToText, OpencodeRuntime } from "../src/opencode-runtime.ts"

function fakeClient(overrides: Record<string, any> = {}) {
  return {
    global: {},
    session: {
      create: async () => ({ data: { id: "ses_1", title: "t" } }),
      list: async () => ({ data: [{ id: "ses_1", title: "t" }] }),
      get: async () => ({ data: { id: "ses_1", title: "t" } }),
      children: async () => ({ data: [{ id: "ses_2", title: "c", parentID: "ses_1" }] }),
      delete: async () => ({ data: true }),
      messages: async () => ({
        data: [
          { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
          { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
        ],
      }),
      prompt: async () => ({
        data: { info: { id: "m3", role: "assistant" }, parts: [{ type: "text", text: "ok" }] },
      }),
      command: async () => ({ data: { info: { id: "m4", role: "assistant" }, parts: [{ type: "text", text: "command ok" }] } }),
      summarize: async () => ({ data: true }),
      fork: async () => ({ data: { id: "ses_3", title: "fork" } }),
      abort: async () => ({ data: true }),
    },
    event: {
      subscribe: async () => ({ stream: (async function* () {})() }),
    },
    ...overrides,
  }
}

test("未提供 baseUrl 时 health 返回 unknown，不依赖 SDK global.health", async () => {
  const rt = new OpencodeRuntime({ client: fakeClient() as any })
  assert.deepEqual(await rt.health(), { healthy: false, version: "unknown" })
})

test("health 通过 HTTP 读取 /global/health", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    assert.match(String(url), /\/global\/health$/)
    return { ok: true, json: async () => ({ healthy: true, version: "1.18.32" }) }
  }) as any
  try {
    const rt = new OpencodeRuntime({
      client: fakeClient() as any,
      baseUrl: "http://127.0.0.1:4199",
    })
    assert.deepEqual(await rt.health(), { healthy: true, version: "1.18.32" })
  } finally {
    globalThis.fetch = original
  }
})

test("会话读取归一化父会话字段", async () => {
  const rt = new OpencodeRuntime({ client: fakeClient() as any })
  const sessions = await rt.listSessions()
  assert.deepEqual(sessions, [{ id: "ses_1", title: "t", parentId: undefined }])
  const children = await rt.children("ses_1")
  assert.equal(children[0].parentId, "ses_1")
})

test("保留 OpenCode 助手消息的完成信息", async () => {
  const client = fakeClient()
  client.session.messages = async () => ({ data: [{ info: { id: "done", role: "assistant", finish: "stop", time: { completed: 1234 } }, parts: [{ type: "text", text: "完成" }] }] })
  const rt = new OpencodeRuntime({ client: client as any })
  assert.deepEqual((await rt.messages("ses_1"))[0], {
    id: "done", role: "assistant", completedAt: 1234, finish: "stop",
    parts: [{ type: "text", text: "完成", tool: undefined, state: undefined, filename: undefined, mime: undefined, url: undefined }],
  })
})

test("归一化助手消息的 token 统计供上下文用量展示", async () => {
  const client = fakeClient()
  client.session.messages = async () => ({ data: [{ info: { id: "done", role: "assistant", tokens: { input: 120, output: 30, reasoning: 5, cache: { read: 1000, write: 50 } } }, parts: [{ type: "text", text: "完成" }] }] })
  const rt = new OpencodeRuntime({ client: client as any })
  assert.deepEqual((await rt.messages("ses_1"))[0].tokens, {
    input: 120, output: 30, reasoning: 5, cacheRead: 1000, cacheWrite: 50,
  })
})

test("读取问答并按 OpenCode 结构提交选项与自定义文本", async () => {
  const original = globalThis.fetch
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  globalThis.fetch = (async (url: string, options?: RequestInit) => {
    calls.push({ url: String(url), method: options?.method ?? "GET", body: options?.body ? JSON.parse(options.body as string) : undefined })
    return { ok: true, json: async () => [{ id: "que_1", sessionID: "ses_1", questions: [{ question: "选择？", header: "方向", options: [{ label: "A", description: "A 路线" }], multiple: true }] }] }
  }) as any
  try {
    const rt = new OpencodeRuntime({ client: fakeClient() as any, baseUrl: "http://127.0.0.1:4199" })
    assert.equal((await rt.listQuestions())[0].id, "que_1")
    await rt.replyQuestion("que_1", [["A", "自定义"]])
    await rt.rejectQuestion("que_2")
    assert.deepEqual(calls.map(({ url, method, body }) => [url.split("4199")[1], method, body]), [
      ["/question", "GET", undefined],
      ["/question/que_1/reply", "POST", { answers: [["A", "自定义"]] }],
      ["/question/que_2/reject", "POST", undefined],
    ])
  } finally {
    globalThis.fetch = original
  }
})

test("prompt 默认不带模型与结构化输出", async () => {
  let captured: any
  const client = fakeClient()
  client.session.prompt = async (args: any) => {
    captured = args
    return { data: { info: { id: "m", role: "assistant" }, parts: [{ type: "text", text: "ok" }] } }
  }
  const rt = new OpencodeRuntime({ client: client as any })
  await rt.prompt({ sessionId: "ses_1", text: "hi" })
  assert.equal(captured.body.model, undefined)
  assert.equal(captured.body.format, undefined)
})

test("prompt 注入模型与 json_schema 结构化输出", async () => {
  let captured: any
  const client = fakeClient()
  client.session.prompt = async (args: any) => {
    captured = args
    return { data: { info: { id: "m", role: "assistant" }, parts: [{ type: "text", text: "ok" }] } }
  }
  const rt = new OpencodeRuntime({
    client: client as any,
    model: { providerID: "p", modelID: "m" },
  })
  await rt.prompt({
    sessionId: "ses_1",
    text: "hi",
    system: "路由上下文",
    agent: "plan",
    jsonSchema: { type: "object", properties: { a: { type: "string" } } },
  })
  assert.deepEqual(captured.body.model, { providerID: "p", modelID: "m" })
  assert.equal(captured.body.agent, "plan")
  assert.equal(captured.body.system, "路由上下文")
  assert.equal(captured.body.format.type, "json_schema")
})

test("只返回 OpenCode 可用的主 agent", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    assert.match(String(url), /\/agent$/)
    return { ok: true, json: async () => [
      { name: "build", mode: "primary" }, { name: "plan", mode: "primary" },
      { name: "hidden", mode: "primary", hidden: true }, { name: "explore", mode: "subagent" },
    ] }
  }) as any
  try {
    const rt = new OpencodeRuntime({ client: fakeClient() as any, baseUrl: "http://127.0.0.1:4199" })
    assert.deepEqual(await rt.listAgents(), [{ name: "build", mode: "primary" }, { name: "plan", mode: "primary" }])
  } finally {
    globalThis.fetch = original
  }
})

test("命令从 OpenCode 枚举，执行时透传当前模型、agent 和参数", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => ({ ok: true, json: async () => [
    { name: "review", description: "Review changes", template: "private template" },
    { name: "review:short", description: "Short review" },
    { name: "bad/name", description: "invalid" },
  ] })) as any
  let body: any
  const client = fakeClient()
  client.session.command = async (args: any) => {
    body = args.body
    return { data: { info: { role: "assistant" }, parts: [{ type: "text", text: "reviewed" }] } }
  }
  try {
    const rt = new OpencodeRuntime({ client: client as any, baseUrl: "http://x" })
    assert.deepEqual(await rt.listCommands(), [{ name: "review", description: "Review changes" }, { name: "review:short", description: "Short review" }])
    assert.deepEqual(await rt.command({ sessionId: "ses_1", name: "review", arguments: "--brief", model: { providerID: "demo", modelID: "alpha" }, agent: "plan" }), { text: "reviewed" })
    assert.deepEqual(body, { command: "review", arguments: "--brief", model: "demo/alpha", agent: "plan" })
    await rt.compact("ses_1", { providerID: "demo", modelID: "alpha" })
  } finally {
    globalThis.fetch = original
  }
})

test("prompt 遇到回复体内部错误并抛出", async () => {
  const client = fakeClient()
  client.session.prompt = async () => ({
    data: { info: { id: "m", error: { name: "StructuredOutputError", message: "bad" } }, parts: [] },
  })
  const rt = new OpencodeRuntime({ client: client as any })
  await assert.rejects(() => rt.prompt({ sessionId: "s", text: "x" }), /StructuredOutputError/)
})

test("prompt 遇到 SDK 顶层 error 字段并抛出，而非静默返回空", async () => {
  const client = fakeClient()
  client.session.prompt = async () => ({
    error: { name: "UnknownError", data: { message: "Unexpected server error" } },
    response: { status: 500 },
  })
  const rt = new OpencodeRuntime({ client: client as any })
  await assert.rejects(
    () => rt.prompt({ sessionId: "s", text: "x" }),
    /UnknownError.*Unexpected server error/,
  )
})

test("abort 透传会话 ID，并报告 OpenCode 的中止错误", async () => {
  const client = fakeClient()
  let id = ""
  client.session.abort = async (args: any) => {
    id = args.path.id
    return { data: true }
  }
  const rt = new OpencodeRuntime({ client: client as any })
  assert.equal(await rt.abort("ses_1"), true)
  assert.equal(id, "ses_1")
  client.session.abort = async () => ({ error: { data: { message: "session unavailable" } } })
  await assert.rejects(() => rt.abort("ses_1"), /停止失败.*session unavailable/)
})

test("prompt 无错误但正文为空时抛出，避免静默成功", async () => {
  const client = fakeClient()
  client.session.prompt = async () => ({
    data: { info: { id: "m", role: "assistant" }, parts: [] },
  })
  const rt = new OpencodeRuntime({ client: client as any })
  await assert.rejects(() => rt.prompt({ sessionId: "s", text: "x" }), /空正文/)
})

test("结构化输出取 info.structured，不因缺少 text part 而误报空正文", async () => {
  const client = fakeClient()
  const structured = { title: "状态管理选型", category: "前端架构", summary: "优先 Zustand" }
  client.session.prompt = async () => ({
    data: { info: { id: "m", role: "assistant", structured }, parts: [{ type: "step-start" }] },
  })
  const rt = new OpencodeRuntime({ client: client as any })
  const res = await rt.prompt({ sessionId: "s", text: "x", jsonSchema: {} })
  assert.deepEqual(res.structuredOutput, structured)
  assert.deepEqual(JSON.parse(res.text), structured)
})

test("结构化输出回退到 StructuredOutput 工具调用", async () => {
  const client = fakeClient()
  const input = { title: "回退路径", category: "测试", summary: "来自工具调用" }
  client.session.prompt = async () => ({
    data: {
      info: { id: "m", role: "assistant" },
      parts: [{ type: "tool", tool: "StructuredOutput", state: { status: "completed", input } }],
    },
  })
  const rt = new OpencodeRuntime({ client: client as any })
  const res = await rt.prompt({ sessionId: "s", text: "x", jsonSchema: {} })
  assert.deepEqual(res.structuredOutput, input)
})

test("有正文时优先正文，不被结构化结果覆盖", async () => {
  const client = fakeClient()
  client.session.prompt = async () => ({
    data: {
      info: { id: "m", role: "assistant", structured: { a: 1 } },
      parts: [{ type: "text", text: "实际正文" }],
    },
  })
  const rt = new OpencodeRuntime({ client: client as any })
  const res = await rt.prompt({ sessionId: "s", text: "x" })
  assert.equal(res.text, "实际正文")
})

test("请求结构化输出时，结构化结果优先于旁白正文", async () => {
  const client = fakeClient()
  const structured = { assignments: [{ slotKey: "idea1" }] }
  client.session.prompt = async () => ({
    data: {
      info: { id: "m", role: "assistant", structured },
      parts: [
        { type: "text", text: "好的，我先分析一下……" },
        { type: "tool", tool: "StructuredOutput", state: { status: "completed", input: structured } },
      ],
    },
  })
  const rt = new OpencodeRuntime({ client: client as any })
  const res = await rt.prompt({ sessionId: "s", text: "x", jsonSchema: {} })
  assert.deepEqual(res.structuredOutput, structured)
  assert.deepEqual(JSON.parse(res.text), structured)
})

test("complete 在临时会话中执行并始终销毁会话", async () => {
  const client = fakeClient()
  const created: string[] = []
  const deleted: string[] = []
  const prompts: any[] = []
  let n = 0
  client.session.create = async () => {
    const id = `ses_tmp${++n}`
    created.push(id)
    return { data: { id, title: "tmp" } }
  }
  client.session.delete = async (args: any) => {
    deleted.push(args.path.id)
    return { data: true }
  }
  client.session.prompt = async (args: any) => {
    prompts.push(args)
    return {
      data: {
        info: { id: "m", role: "assistant", structured: { title: "t" } },
        parts: [],
      },
    }
  }
  const rt = new OpencodeRuntime({ client: client as any })
  const out = await rt.complete({ prompt: "p", system: "SYS", jsonSchema: {} })
  assert.deepEqual(JSON.parse(out), { title: "t" })
  assert.deepEqual(created, deleted, "临时会话必须被销毁")
  assert.equal(prompts.length, 1, "system 与用户文本必须在同一次 prompt 中发送")
  assert.equal(prompts[0].body.system, "SYS")
  assert.equal(prompts[0].body.noReply, undefined, "不再用 noReply 两步注入 system")
})

test("complete 失败时也销毁临时会话", async () => {
  const client = fakeClient()
  const deleted: string[] = []
  client.session.create = async () => ({ data: { id: "ses_fail", title: "tmp" } })
  client.session.delete = async (args: any) => {
    deleted.push(args.path.id)
    return { data: true }
  }
  client.session.prompt = async () => ({
    error: { name: "UnknownError", data: { message: "boom" } },
  })
  const rt = new OpencodeRuntime({ client: client as any })
  await assert.rejects(() => rt.complete({ prompt: "p" }), /UnknownError/)
  assert.deepEqual(deleted, ["ses_fail"], "失败路径也必须销毁临时会话")
})

test("消息文本拼接用于 NodeX 侧索引", async () => {
  const rt = new OpencodeRuntime({ client: fakeClient() as any })
  const text = messagesToText(await rt.messages("ses_1"))
  assert.equal(text, "hi\n\nhello")
})

test("seed 使用 noReply 注入上下文，不触发模型生成", async () => {
  let seen: any = null
  const client = fakeClient()
  client.session.prompt = async (args: any) => {
    seen = args
    return { data: { info: { id: "m_seed", role: "user" }, parts: [{ type: "text", text: args.body.parts[0].text }] } }
  }
  const rt = new OpencodeRuntime({ client: client as any })
  await rt.seed("ses_1", "【导出的上下文】背景资料")
  assert.equal(seen.body.noReply, true, "必须带 noReply，避免产生空回复")
  assert.equal(seen.body.parts[0].text, "【导出的上下文】背景资料")
})

test("seed 遇到 SDK 顶层错误时显式抛出", async () => {
  const client = fakeClient()
  client.session.prompt = async () => ({ error: { name: "BadRequest", data: { message: "boom" } } })
  const rt = new OpencodeRuntime({ client: client as any })
  await assert.rejects(() => rt.seed("ses_1", "x"), /注入上下文失败/)
})

test("prompt 的单次 model 覆盖优先于运行时默认模型", async () => {
  let captured: any
  const client = fakeClient()
  client.session.prompt = async (args: any) => {
    captured = args
    return { data: { info: { id: "m", role: "assistant" }, parts: [{ type: "text", text: "ok" }] } }
  }
  const rt = new OpencodeRuntime({
    client: client as any,
    model: { providerID: "default", modelID: "a" },
  })
  await rt.prompt({
    sessionId: "s",
    text: "x",
    model: { providerID: "override", modelID: "b" },
  })
  assert.deepEqual(captured.body.model, { providerID: "override", modelID: "b" })
})

test("listModels 从 /config 展开 provider 下的模型", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    if (String(url).endsWith("/config")) return { ok: true, json: async () => ({ model: "test-provider/gpt-x" }) }
    assert.match(String(url), /\/config\/providers$/)
    return {
      ok: true,
      json: async () => ({
        providers: [
          { id: "test-provider", name: "test-provider", models: { "gpt-x": { name: "GPT X" }, deepseek: {} } },
          { id: "anthropic", models: { "claude-y": { name: "Claude Y" }, legacy: { status: "deprecated" } } },
        ],
      }),
    }
  }) as any
  try {
    const rt = new OpencodeRuntime({ client: fakeClient() as any, baseUrl: "http://x" })
    const models = await rt.listModels()
    assert.equal(models.length, 3)
    assert.deepEqual(
      models.find((m) => m.modelID === "gpt-x"),
      { providerID: "test-provider", modelID: "gpt-x", name: "GPT X", providerName: "test-provider" },
    )
    assert.equal(models.find((m) => m.modelID === "deepseek")?.name, "deepseek")
    assert.deepEqual(await rt.defaultModel(), { providerID: "test-provider", modelID: "gpt-x" })
    assert.equal(await rt.defaultAgent(), undefined)
  } finally {
    globalThis.fetch = original
  }
})

test("listModels 未配置 baseUrl 时返回空数组", async () => {
  const rt = new OpencodeRuntime({ client: fakeClient() as any })
  assert.deepEqual(await rt.listModels(), [])
})

test("运行时默认模型不在 provider 清单时仍可选", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string) => ({ ok: true, json: async () => String(url).endsWith("/config")
    ? { model: "demo/model-new" }
    : { providers: [{ id: "demo", models: { old: {} } }] },
  })) as any
  try {
    const rt = new OpencodeRuntime({ client: fakeClient() as any, baseUrl: "http://x" })
    assert.deepEqual((await rt.listModels()).map((item) => item.modelID), ["model-new", "old"])
  } finally {
    globalThis.fetch = original
  }
})

test("listModels 暴露模型的推理强度变体", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    if (String(url).endsWith("/config")) return { ok: true, json: async () => ({}) }
    return {
      ok: true,
      json: async () => ({
        providers: [
          {
            id: "test-provider",
            options: { reasoningEffort: "low" },
            models: {
              "gpt-x": { name: "GPT X", variants: { low: {}, high: {} } },
              plain: { options: { reasoningEffort: "high" } },
              bare: {},
            },
          },
        ],
      }),
    }
  }) as any
  try {
    const rt = new OpencodeRuntime({ client: fakeClient() as any, baseUrl: "http://x" })
    const models = await rt.listModels()
    assert.deepEqual(models.find((m) => m.modelID === "gpt-x")?.variants, ["low", "high"])
    assert.equal(models.find((m) => m.modelID === "plain")?.variants, undefined)
    // defaultEffort：模型级覆盖 provider 级，未声明的回落到 provider 级
    assert.equal(models.find((m) => m.modelID === "plain")?.defaultEffort, "high")
    assert.equal(models.find((m) => m.modelID === "bare")?.defaultEffort, "low")
  } finally {
    globalThis.fetch = original
  }
})

test("prompt 与 command 透传推理强度变体", async () => {
  let promptBody: any
  let commandBody: any
  const client = fakeClient()
  client.session.prompt = async (args: any) => {
    promptBody = args.body
    return { data: { info: { id: "m", role: "assistant" }, parts: [{ type: "text", text: "ok" }] } }
  }
  client.session.command = async (args: any) => {
    commandBody = args.body
    return { data: { info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }] } }
  }
  const rt = new OpencodeRuntime({ client: client as any })
  await rt.prompt({ sessionId: "s", text: "x", variant: "high" })
  assert.equal(promptBody.variant, "high")
  await rt.command({ sessionId: "s", name: "review", arguments: "", variant: "low" })
  assert.equal(commandBody.variant, "low")
})

test("toMessages 保留 tool part 的工具名与状态，供文件预览解析", async () => {
  const client = fakeClient()
  client.session.messages = async () => ({
    data: [
      {
        info: { id: "m1", role: "assistant" },
        parts: [
          { type: "tool", tool: "write", state: { input: { filePath: "/tmp/a.md" }, status: "completed" } },
          { type: "file", filename: "/tmp/b.png", mime: "image/png", url: "file:///tmp/b.png" },
        ],
      },
    ],
  })
  const rt = new OpencodeRuntime({ client: client as any })
  const [msg] = await rt.messages("s")
  assert.equal(msg.parts[0].tool, "write")
  assert.equal((msg.parts[0].state as any).input.filePath, "/tmp/a.md")
  assert.equal(msg.parts[1].filename, "/tmp/b.png")
  assert.equal(msg.parts[1].mime, "image/png")
})
