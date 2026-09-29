import { test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GraphStore } from "../src/store.ts"
import { collaborationLayout } from "../src/collaboration.ts"
import { newNode } from "../src/mapper.ts"

test("sending to the brainstorming main node runs each child before the summary and exposes reasoning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nodex-collaboration-"))
  const calls: string[] = []
  const activeWorkers = new Set<string>()
  let maxConcurrentWorkers = 0
  const conversationCalls = () => calls.filter((id) => !id.startsWith("ses_meta_"))
  const promptBodies: Array<{ id: string; body: { parts: Array<{ text: string }>; model?: { providerID: string; modelID: string }; agent?: string } }> = []
  const commands: Array<{ id: string; body: { command: string; arguments: string; model?: string; agent?: string } }> = []
  const compactions: Array<{ id: string; model: { providerID: string; modelID: string } }> = []
  const aborts: string[] = []
  const seeds: Array<{ noReply: boolean; text: string }> = []
  const messages = new Map<string, unknown[]>()
  const statuses = new Map<string, { type: string }>()
  const pendingQuestions = new Map<string, { id: string; sessionID: string; questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiple?: boolean; custom?: boolean }> }>()
  const questionReplies: string[][][] = []
  let metaSessionCounter = 0
  const listeners = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const emit = (type: string, properties: unknown) => {
    const frame = new TextEncoder().encode(`data: ${JSON.stringify({ type, properties })}\n\n`)
    for (const listener of listeners) listener.enqueue(frame)
  }
  const fake = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/session/status") return Response.json(Object.fromEntries(statuses))
      if (url.pathname === "/llm/chat/completions") {
        const body = await req.json() as { messages: Array<{ content: string }> }
        const text = body.messages.map((m) => m.content).join("\n")
        const content = text.includes("会议")
          ? JSON.stringify({ title: "摘录笔记", categories: [], summary: "记录了选中的短语" })
          : JSON.stringify({ title: "AI 标题", categories: [], summary: "AI 摘要" })
        return Response.json({ choices: [{ message: { role: "assistant", content } }] })
      }
      if (url.pathname === "/question") return Response.json([...pendingQuestions.values()])
      const questionAction = /^\/question\/([^/]+)\/(reply|reject)$/.exec(url.pathname)
      if (questionAction) {
        const request = pendingQuestions.get(questionAction[1])
        if (!request) return Response.json({ error: "not found" }, { status: 404 })
        if (questionAction[2] === "reply") questionReplies.push((await req.json() as { answers: string[][] }).answers)
        pendingQuestions.delete(request.id)
        return Response.json(true)
      }
      if (url.pathname === "/session" && req.method === "GET") return Response.json([
        { id: "node_plain", title: "Plain" }, { id: "ses_external", title: "External session" },
      ])
      if (url.pathname === "/session" && req.method === "POST") {
        const body = await req.json() as { title: string }
        const id = body.title === "__nodex_meta__" ? `ses_meta_${++metaSessionCounter}` : "ses_export_context"
        return Response.json({ id, title: body.title })
      }
      if (url.pathname === "/session/ses_external" && req.method === "GET") return Response.json({ id: "ses_external", title: "External session" })
      if (url.pathname === "/agent") return Response.json([{ name: "build", mode: "primary" }, { name: "plan", mode: "primary" }, { name: "hidden", mode: "primary", hidden: true }])
      if (url.pathname === "/config") return Response.json({ model: "demo/beta", default_agent: "plan", provider: { demo: { models: { alpha: { name: "Alpha" }, beta: { name: "Beta" } } } } })
      if (url.pathname === "/config/providers") return Response.json({ providers: [{ id: "demo", models: { alpha: { name: "Alpha" }, beta: { name: "Beta" } } }] })
      if (url.pathname === "/command") return Response.json([
        { name: "review", description: "Review changes", source: "command", template: "do not leak" },
        { name: "some-skill", description: "A skill", source: "skill", template: "do not leak" },
      ])
      if (url.pathname === "/event") {
        let listener: ReadableStreamDefaultController<Uint8Array>
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { listener = controller; listeners.add(controller) },
          cancel() { listeners.delete(listener) },
        }), { headers: { "content-type": "text/event-stream" } })
      }
      const compactMatch = /^\/session\/([^/]+)\/summarize$/.exec(url.pathname)
      if (compactMatch) {
        compactions.push({ id: compactMatch[1], model: await req.json() as { providerID: string; modelID: string } })
        return Response.json(true)
      }
      if (url.pathname === "/session/node_plain/fork") return Response.json({ id: "ses_fork_plain", title: "Forked" })
      if (url.pathname === "/session/ses_export_context/message" && req.method === "POST") {
        const body = await req.json() as { noReply: boolean; parts: Array<{ text: string }> }
        seeds.push({ noReply: body.noReply, text: body.parts[0].text })
        return Response.json({ info: { id: "seed", role: "user" }, parts: body.parts })
      }
      if (url.pathname === "/session/node_plain/abort") {
        aborts.push("node_plain")
        statuses.delete("node_plain")
        return Response.json(true)
      }
      const commandMatch = /^\/session\/([^/]+)\/command$/.exec(url.pathname)
      if (commandMatch) {
        const body = await req.json() as { command: string; arguments: string; model?: string; agent?: string }
        commands.push({ id: commandMatch[1], body })
        if (body.arguments.includes("simulate command failure") && commandMatch[1] === "node_idea2") {
          return Response.json({ name: "APIError", data: { message: "command unavailable" } }, { status: 503 })
        }
        const result = { info: { id: "review_reply", role: "assistant" }, parts: [{ type: "text", text: "review completed" }] }
        messages.set(commandMatch[1], [...(messages.get(commandMatch[1]) ?? []), result])
        return Response.json(result)
      }
      const match = /^\/session\/([^/]+)\/message$/.exec(url.pathname)
      if (!match) return Response.json({ error: "unknown route", path: url.pathname }, { status: 404 })
      const id = match[1]
      if (req.method === "GET") return Response.json(messages.get(id) ?? [])
      const body = await req.json() as { parts: Array<{ text: string }>; model?: { providerID: string; modelID: string }; agent?: string }
      calls.push(id)
      promptBodies.push({ id, body })
      if (body.parts.some((part) => part.text.trimEnd().endsWith("simulate upstream failure"))) {
        messages.set(id, [...(messages.get(id) ?? []), { info: { id: `failed_${id}`, role: "user" }, parts: body.parts }])
        return Response.json({ name: "APIError", data: { message: "upstream unavailable" } }, { status: 503 })
      }
      if (body.parts.some((part) => part.text.trimEnd().endsWith("simulate reply error"))) {
        return Response.json({ info: { id: `reply_error_${id}`, role: "assistant", error: { name: "APIError", data: { message: "provider endpoint not supported" } } }, parts: [] })
      }
      const requestText = (body.parts ?? []).map((part) => part.text ?? "").join("\n")
      if (id.startsWith("ses_meta_") && requestText.includes("当前标题（可优化）：论文 2")) {
        return Response.json({ name: "APIError", data: { message: "metadata unavailable" } }, { status: 503 })
      }
      if (id.startsWith("node_idea")) {
        activeWorkers.add(id)
        maxConcurrentWorkers = Math.max(maxConcurrentWorkers, activeWorkers.size)
        await new Promise((resolve) => setTimeout(resolve, 15))
        activeWorkers.delete(id)
      }
      const plan = requestText.includes("为每个协作子角色规划")
        ? JSON.stringify({ assignments: collaborationLayout("brainstorm", { agents: 6 }).slots.filter((slot) => slot.key !== "center").map((slot, index) => ({
          slotKey: slot.key, title: `论文 ${index + 1}`, task: `只研究论文 ${index + 1}，排除其他角色方向`, context: `论文 ${index + 1} 的摘要与方法`,
        })) })
        : null
      const metadataTitle = /当前标题（可优化）：论文 (\d+)/.exec(requestText)?.[1]
      const reply = plan ?? (metadataTitle ? JSON.stringify({ title: `论文 ${metadataTitle} 深入研究`, categories: [], summary: "研究摘要" }) : id === "node_idea1" && requestText.endsWith("深入追问") ? "deep result from node_idea1" : `result from ${id}`)
      const entry = {
        info: { id: `reply_${id}`, role: "assistant", finish: "stop", time: { completed: Date.now() } },
        parts: [{ type: "reasoning", text: `reason from ${id}` }, { type: "text", text: reply }],
      }
      messages.set(id, [...(messages.get(id) ?? []), { info: { id: `task_${id}`, role: "user" }, parts: body.parts }, entry])
      emit("message.updated", { info: { id: `reply_${id}`, role: "assistant", sessionID: id } })
      emit("message.part.updated", { part: { id: `reason_${id}`, type: "reasoning", sessionID: id } })
      emit("message.part.updated", { part: { id: `tool_${id}`, type: "tool", tool: "webfetch", sessionID: id, state: { status: "error", error: "Request timed out" } } })
      emit("message.part.delta", { sessionID: id, messageID: `reply_${id}`, partID: `reason_${id}`, delta: `reason from ${id}` })
      return Response.json(entry)
    },
  })
  const previous = { port: process.env.NODEX_PORT, data: process.env.NODEX_DATA_DIR, base: process.env.OPENCODE_BASE_URL, aiBase: process.env.NODEX_AI_BASE_URL, aiKey: process.env.NODEX_AI_API_KEY, aiModel: process.env.NODEX_AI_MODEL }
  let server: Awaited<typeof import("../src/server.ts")>["server"] | undefined
  try {
    const shape = collaborationLayout("brainstorm", { agents: 6 })
    const store = new GraphStore(join(dir, "graph.json"))
    const slots = shape.slots.map((slot) => ({ ...slot, nodeId: `node_${slot.key}` }))
    for (const slot of slots) store.upsertNode(newNode({ id: slot.nodeId, title: slot.label, opencodeSessionId: slot.nodeId }))
    store.patchNode("node_idea3", { title: "手动命名的节点" })
    messages.set("node_center", [
      { info: { id: "main_request", role: "user" }, parts: [{ type: "text", text: "论文调研主题：比较扩散模型中的采样方法" }] },
      { info: { id: "main_context", role: "assistant" }, parts: [{ type: "text", text: "重点关注质量、速度和适用场景，避免重复比较同一方法。" }] },
    ])
    store.upsertNode(newNode({ id: "node_plain", title: "Plain", opencodeSessionId: "node_plain" }))
    messages.set("node_plain", [
      { info: { id: "plain_user", role: "user" }, parts: [{ type: "text", text: "An ordinary user question should stay intact" }] },
      { info: { id: "plain_done", role: "assistant", finish: "stop", time: { completed: 1 }, tokens: { input: 200, output: 40, reasoning: 5, cache: { read: 3000, write: 10 } } }, parts: [{ type: "text", text: "回答" }] },
    ])
    store.upsertCollaboration({
      id: "test-brainstorm", name: "Brainstorm", kind: "brainstorm", config: { agents: 6 },
      mainKey: shape.mainKey, slots, links: shape.links, ownedNodeIds: slots.map((slot) => slot.nodeId),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })
    process.env.NODEX_PORT = "0"
    process.env.NODEX_DATA_DIR = dir
    process.env.OPENCODE_BASE_URL = `http://127.0.0.1:${fake.port}`
    process.env.NODEX_AI_BASE_URL = `http://127.0.0.1:${fake.port}/llm`
    process.env.NODEX_AI_API_KEY = "test-key"
    process.env.NODEX_AI_MODEL = "test-model"
    server = (await import("../src/server.ts")).server
    const base = `http://127.0.0.1:${server.port}`
    const templates = await (await fetch(`${base}/templates`)).json() as { templates: Array<{ id: string; slots: Array<{ key: string; label: string }>; links: Array<{ from: string; to: string }> }> }
    const ministries = templates.templates.find((item) => item.id === "builtin-three-ministries-six-boards")!
    expect(ministries.slots[0]).toMatchObject({ key: "emperor", label: "皇帝" })
    expect(ministries.links.filter((link) => link.from === "emperor")).toHaveLength(3)
    const patchCategory = (value: unknown) => fetch(`${base}/nodes/node_plain`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
    })
    expect(await (await patchCategory({ categories: ["前端", "API", "前端", " "] })).json()).toMatchObject({ categories: ["前端", "API"], category: "前端" })
    expect((await patchCategory({ categories: "前端" })).status).toBe(400)
    expect(await (await patchCategory({ category: "测试" })).json()).toMatchObject({ categories: ["测试"], category: "测试" })
    expect((await patchCategory({ categories: ["前端", "API"] })).status).toBe(200)
    const categorizedNotebook = await (await fetch(`${base}/nodes`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "notebook", title: "类别笔记", categories: ["前端", " API ", "前端"] }),
    })).json() as { categories: string[]; category: string }
    expect(categorizedNotebook).toMatchObject({ categories: ["前端", "API"], category: "前端" })
    expect((await fetch(`${base}/nodes`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "notebook", categories: "前端" }),
    })).status).toBe(400)
    const iconPatched = await (await fetch(`${base}/nodes/node_plain`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ iconColor: "#a7c7e7" }),
    })).json() as { meta: Record<string, unknown> }
    expect(iconPatched.meta.iconColor).toBe("#a7c7e7")
    expect((await patchCategory({ iconColor: "red" })).status).toBe(400)
    const defaultSettings = await (await fetch(`${base}/settings`)).json() as { contextLimit: number }
    expect(defaultSettings.contextLimit).toBe(300000)
    const savedSettings = await (await fetch(`${base}/settings`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ contextLimit: 128000 }),
    })).json() as { contextLimit: number }
    expect(savedSettings.contextLimit).toBe(128000)
    expect((await fetch(`${base}/settings`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ contextLimit: 10 }),
    })).status).toBe(400)
    const plainTokens = (await (await fetch(`${base}/nodes/node_plain`)).json() as { messages: Array<{ role: string; tokens: unknown }> })
      .messages.find((message) => message.role === "assistant" && message.tokens)
    expect(plainTokens?.tokens).toMatchObject({ input: 200, output: 40, reasoning: 5, cacheRead: 3000, cacheWrite: 10 })
    const layoutHeaders = { "content-type": "application/json" }
    expect((await fetch(`${base}/layouts`, { method: "POST", headers: layoutHeaders, body: JSON.stringify({ positions: [] }) })).status).toBe(400)
    const layoutSet = await (await fetch(`${base}/layouts`, {
      method: "POST", headers: layoutHeaders, body: JSON.stringify({ positions: { node_plain: { x: 12, y: -8 } } }),
    })).json() as { updated: number; viewId: string }
    expect(layoutSet).toMatchObject({ updated: 1, viewId: "2d-canvas" })
    const graphAfterLayout = await (await fetch(`${base}/graph`)).json() as { nodes: Array<{ id: string; layouts: Record<string, { position: { x: number; y: number }; pinned: boolean }> }> }
    expect(graphAfterLayout.nodes.find((node) => node.id === "node_plain")?.layouts["2d-canvas"])
      .toMatchObject({ position: { x: 12, y: -8, z: 0 }, pinned: true })
    expect(await (await fetch(`${base}/layouts`, {
      method: "POST", headers: layoutHeaders, body: JSON.stringify({ positions: {}, clear: true }),
    })).json()).toMatchObject({ cleared: true })
    const graphAfterClear = await (await fetch(`${base}/graph`)).json() as { nodes: Array<{ id: string; layouts: Record<string, unknown> }> }
    expect(graphAfterClear.nodes.find((node) => node.id === "node_plain")?.layouts["2d-canvas"]).toBeUndefined()
    const availableAgents = await (await fetch(`${base}/agents`)).json() as { agents: Array<{ name: string }>; default: string }
    expect(availableAgents.agents.map((agent) => agent.name)).toEqual(["build", "plan"])
    expect(availableAgents.default).toBe("plan")
    expect((await (await fetch(`${base}/commands`)).json() as { commands: unknown[] }).commands).toEqual([
      { name: "review", description: "Review changes", source: "command" },
      { name: "some-skill", description: "A skill", source: "skill" },
    ])
    expect((await (await fetch(`${base}/models`)).json() as { default: { modelID: string } }).default.modelID).toBe("beta")
    const settings = (id: string, value: unknown) => fetch(`${base}/nodes/${id}/session-settings`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
    })
    expect((await settings("node_plain", { model: { providerID: "demo", modelID: "beta" }, agent: "plan" })).status).toBe(200)
    expect((await settings("node_center", { model: { providerID: "demo", modelID: "alpha" }, agent: "build" })).status).toBe(200)
    expect((await settings("node_plain", { agent: "hidden" })).status).toBe(400)
    expect((await settings("node_plain", { model: { providerID: "demo", modelID: "missing" } })).status).toBe(400)
    expect(new GraphStore(join(dir, "graph.json")).node("node_plain")?.meta).toMatchObject({ model: { providerID: "demo", modelID: "beta" }, agent: "plan" })
    const request = () => fetch(`${base}/nodes/node_center/prompt/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "compose", arguments: "Research this topic" }),
    })
    const response = await request()
    expect(await response.clone().text()).not.toContain('"type":"error"')
    expect(response.status).toBe(200)
    const frames = (await response.text()).split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.slice(6)))
    expect(frames.filter((event) => event.type === "collaboration")).toHaveLength(13)
    expect(frames.filter((event) => event.type === "collaboration" && event.phase === "started")).toHaveLength(6)
    expect(frames.filter((event) => event.type === "collaboration" && event.phase === "finished")).toHaveLength(6)
    expect(frames.find((event) => event.type === "collaboration" && event.phase === "summary")?.completed).toBe(6)
    expect(maxConcurrentWorkers).toBeGreaterThan(1)
    expect(frames.some((event) => event.type === "tool" && event.name === "webfetch" && event.error === "Request timed out")).toBe(true)
    expect(frames.filter((event) => event.type === "thinking").at(-1)?.text).toBe("reason from node_center")
    expect(frames.at(-1)).toMatchObject({ type: "done", reply: "result from node_center" })
    const childResults = await (await fetch(`${base}/nodes/node_center/collaboration-results`)).json() as { workers: Array<{ nodeId: string; title: string; preview: string }> }
    expect(childResults.workers).toHaveLength(6)
    expect(childResults.workers[0]).toMatchObject({ nodeId: "node_idea1", title: "论文 1 深入研究", preview: "result from node_idea1" })
    expect(childResults.workers[1].title).toBe("论文 2")
    expect(childResults.workers[2].title).toBe("手动命名的节点")
    expect((await (await fetch(`${base}/nodes/node_idea1/collaboration-results`)).json() as { mainNodeId: string }).mainNodeId).toBe("node_center")
    expect(promptBodies.findLast((entry) => entry.id === "node_center")).toMatchObject({ id: "node_center", body: { model: { providerID: "demo", modelID: "alpha" }, agent: "build" } })
    expect(conversationCalls()).toEqual([...slots.filter((slot) => slot.key !== "center").map((slot) => slot.nodeId), "node_center"])
    const detail = await (await fetch(`${base}/nodes/node_center`)).json() as { messages: Array<{ reasoning: string }> }
    expect(detail.messages.at(-1)?.reasoning).toBe("reason from node_center")
    expect((detail.messages.at(-2) as { text: string }).text).toBe("Research this topic")
    const planned = promptBodies.find((entry) => entry.id.startsWith("ses_meta_") && entry.body.parts?.[0]?.text?.includes("为每个协作子角色规划"))
    expect(planned?.body.parts?.[0]?.text).toContain("论文调研主题：比较扩散模型中的采样方法")
    const workerPrompts = promptBodies.filter((entry) => entry.id.startsWith("node_idea") && entry.body.parts?.[0]?.text?.includes("专属子任务："))
    expect(workerPrompts).toHaveLength(6)
    expect(workerPrompts.every((entry) => !entry.body.parts[0].text.includes("共享目标：Research this topic"))).toBe(true)
    expect(workerPrompts.every((entry, index) => entry.body.parts[0].text.includes(`专属背景：论文 ${index + 1} 的摘要与方法`))).toBe(true)
    expect(workerPrompts.every((entry) => !entry.body.parts[0].text.includes("重点关注质量、速度和适用场景"))).toBe(true)
    expect(workerPrompts.every((entry, index) => !entry.body.parts[0].text.includes(`专属背景：论文 ${((index + 1) % 6) + 1} 的摘要与方法`))).toBe(true)
    // 子角色未单独设置模型时沿用主节点模型，而不是退回全局默认。
    expect(promptBodies.filter((entry) => entry.body.parts?.[0]?.text?.includes("专属子任务：")).every((entry) =>
      entry.body.model?.providerID === "demo" && entry.body.model?.modelID === "alpha",
    )).toBe(true)
    const plain = await (await fetch(`${base}/nodes/node_plain`)).json() as { messages: Array<{ text: string }> }
    expect(plain.messages[0]?.text).toBe("An ordinary user question should stay intact")
    const plainSend = await fetch(`${base}/nodes/node_plain/prompt`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "use plan" }),
    })
    expect(plainSend.status).toBe(200)
    expect(promptBodies.at(-1)).toMatchObject({ id: "node_plain", body: { model: { providerID: "demo", modelID: "beta" }, agent: "plan" } })
    const plainSecond = await fetch(`${base}/nodes/node_plain/prompt/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "a second question" }),
    })
    expect(await plainSecond.text()).toContain('"type":"done","reply":"result from node_plain"')
    const plainHistory = await (await fetch(`${base}/nodes/node_plain`)).json() as { messages: Array<{ role: string; text: string }> }
    expect(plainHistory.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
      "An ordinary user question should stay intact", "use plan", "a second question",
    ])
    statuses.set("node_plain", { type: "busy" })
    const stop = await fetch(`${base}/nodes/node_plain/abort`, { method: "POST" })
    expect(await stop.json()).toEqual({ aborted: true })
    expect(aborts).toEqual(["node_plain"])
    expect((await fetch(`${base}/nodes/unknown/abort`, { method: "POST" })).status).toBe(404)
    expect((await settings("node_plain", { model: null, agent: null })).status).toBe(200)
    expect(new GraphStore(join(dir, "graph.json")).node("node_plain")?.meta).not.toHaveProperty("agent")
    const before = await (await fetch(`${base}/nodes/node_plain`)).json() as { node: { updatedAt: string } }
    statuses.set("node_plain", { type: "busy" })
    const busy = await (await fetch(`${base}/runtime/status`)).json() as { available: boolean; sessions: Record<string, { status: string }>; activity: Record<string, string> }
    expect(busy.available).toBe(true)
    expect(busy.sessions.node_plain.status).toBe("busy")
    expect(busy.activity.node_plain).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/)
    statuses.delete("node_plain")
    const idle = await (await fetch(`${base}/runtime/status`)).json() as { sessions: Record<string, unknown>; activity: Record<string, string> }
    expect(idle.sessions.node_plain).toBeUndefined()
    const after = await (await fetch(`${base}/nodes/node_plain`)).json() as { node: { updatedAt: string; lastActiveAt: string } }
    expect(after.node.lastActiveAt).toBe(idle.activity.node_plain)
    expect(after.node.updatedAt).toBe(before.node.updatedAt)
    pendingQuestions.set("que_plain", { id: "que_plain", sessionID: "node_plain", questions: [
      { question: "哪些方向？", header: "方向", options: [{ label: "A", description: "选 A" }], multiple: true },
      { question: "如何输出？", header: "产物", options: [{ label: "表格", description: "对比" }], custom: false },
    ] })
    statuses.set("node_plain", { type: "busy" })
    const waiting = await (await fetch(`${base}/runtime/status`)).json() as { sessions: Record<string, unknown>; questions: Record<string, Array<{ id: string }>> }
    expect(waiting.sessions.node_plain).toBeUndefined()
    expect(waiting.questions.node_plain[0].id).toBe("que_plain")
    const answerQuestion = (nodeId: string, answers: unknown) => fetch(`${base}/nodes/${nodeId}/questions/que_plain/reply`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answers }),
    })
    expect((await answerQuestion("node_center", [["A"], ["表格"]])).status).toBe(404)
    expect((await answerQuestion("node_plain", [["A"]])).status).toBe(400)
    expect((await answerQuestion("node_plain", [["A"], ["未给出的选项"]])).status).toBe(400)
    expect((await answerQuestion("node_plain", [["A", "自定义"], ["表格"]])).status).toBe(200)
    expect(questionReplies).toEqual([[["A", "自定义"], ["表格"]]])
    pendingQuestions.set("que_plain", { id: "que_plain", sessionID: "node_plain", questions: [{ question: "继续？", header: "继续", options: [] }] })
    expect((await fetch(`${base}/nodes/node_plain/questions/que_plain/reject`, { method: "POST" })).status).toBe(200)
    const completedAt = Date.now() - 20000
    messages.set("node_plain", [...(messages.get("node_plain") ?? []), { info: { id: "finished_plain", role: "assistant", finish: "stop", time: { completed: completedAt } }, parts: [{ type: "text", text: "调研已完成" }] }])
    const stale = await (await fetch(`${base}/runtime/status`)).json() as { sessions: Record<string, unknown>; stale: Record<string, number> }
    expect(stale.sessions.node_plain).toBeUndefined()
    expect(stale.stale.node_plain).toBe(completedAt)
    expect((await (await fetch(`${base}/nodes/node_plain`)).json() as { messages: Array<{ completedAt?: number }> }).messages.at(-1)?.completedAt).toBe(completedAt)
    statuses.delete("node_plain")
    await fetch(`${base}/runtime/status`)
    const empty = await fetch(`${base}/nodes/node_center/prompt/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "  " }),
    })
    expect(empty.status).toBe(400)
    const second = await request()
    expect(second.status).toBe(200)
    expect((await second.text())).toContain('"type":"done"')
    expect(conversationCalls()).toHaveLength(16)
    const ordinary = await fetch(`${base}/nodes/node_center/prompt`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Another topic" }),
    })
    expect(ordinary.status).toBe(200)
    expect((await ordinary.json() as { reply: string }).reply).toBe("result from node_center")
    expect(conversationCalls()).toHaveLength(17)
    const latestUser = (messages.get("node_center") as Array<{ info: { role: string }; parts: Array<{ text: string }> }>).filter((entry) => entry.info.role === "user").at(-1)
    expect(latestUser?.parts[0].text.endsWith("Another topic")).toBe(true)
    const noArguments = await fetch(`${base}/nodes/node_center/prompt/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "compose", arguments: "" }),
    })
    expect((await noArguments.text())).toContain('"type":"done"')
    const plannedLatest = promptBodies.filter((entry) => entry.id.startsWith("ses_meta_") && entry.body.parts?.[0]?.text?.includes("为每个协作子角色规划")).at(-1)
    expect(plannedLatest?.body.parts[0].text).toContain("用户目标：Another topic")
    const collaborationCommand = await fetch(`${base}/nodes/node_center/prompt/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "compose", arguments: "比较论文调研中的采样方法" }),
    })
    const commandFrames = (await collaborationCommand.text()).split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.slice(6)))
    expect(commandFrames.at(-1)).toMatchObject({ type: "done", reply: "result from node_center" })
    expect(commandFrames.filter((event) => event.type === "collaboration")).toHaveLength(13)
    expect(commands).toHaveLength(0)
    const mainCommand = await fetch(`${base}/nodes/node_center/prompt/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "review", arguments: "main only" }),
    })
    const mainCommandFrames = (await mainCommand.text()).split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.slice(6)))
    expect(mainCommandFrames.at(-1)).toMatchObject({ type: "done", reply: "review completed" })
    expect(mainCommandFrames.some((event) => event.type === "collaboration")).toBe(false)
    expect(commands.at(-1)?.id).toBe("node_center")
    expect(promptBodies.filter((entry) => entry.body.parts?.[0]?.text?.includes("专属子任务：")).length).toBeGreaterThanOrEqual(12)
    const failedCollaboration = await fetch(`${base}/nodes/node_center/prompt/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "compose", arguments: "simulate upstream failure" }),
    })
    const failureFrame = (await failedCollaboration.text()).split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.slice(6))).at(-1)
    expect(failureFrame).toMatchObject({ type: "error", results: expect.any(Array) })
    const composeWithoutInstance = await fetch(`${base}/nodes/node_plain/prompt/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "compose", arguments: "unused" }),
    })
    expect(composeWithoutInstance.status).toBe(409)
    const failure = await fetch(`${base}/nodes/node_plain/prompt/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "simulate upstream failure" }),
    })
    expect(failure.status).toBe(200)
    expect(await failure.text()).toContain('"type":"error","error":"opencode: 提示失败 APIError upstream unavailable"')
    const persisted = await (await fetch(`${base}/nodes/node_plain`)).json() as { messages: Array<{ text: string; role: string }> }
    expect(persisted.messages.at(-1)).toMatchObject({ role: "user", text: "simulate upstream failure" })
    const replyError = await fetch(`${base}/nodes/node_plain/prompt/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "simulate reply error" }),
    })
    expect(await replyError.text()).toContain('"type":"error","error":"opencode: 提示失败 APIError provider endpoint not supported"')
    expect((await fetch(`${base}/nodes/node_plain/prompt/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "unknown", arguments: "" }),
    })).status).toBe(400)
    expect((await settings("node_plain", { agent: "plan", model: { providerID: "demo", modelID: "beta" } })).status).toBe(200)
    const commandResponse = await fetch(`${base}/nodes/node_plain/prompt/stream`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "review", arguments: "--brief" }),
    })
    expect((await commandResponse.text())).toContain('"type":"done","reply":"review completed"')
    expect(commands.at(-1)).toMatchObject({ id: "node_plain", body: { command: "review", arguments: "--brief", model: "demo/beta", agent: "plan" } })
    const compact = await fetch(`${base}/nodes/node_plain/compact`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    expect(await compact.json()).toEqual({ compacted: true })
    expect(compactions).toEqual([{ id: "node_plain", model: { providerID: "demo", modelID: "beta" } }])
    const availableSessions = await (await fetch(`${base}/sessions`)).json() as { sessions: Array<{ id: string; nodeId: string | null }> }
    expect(availableSessions.sessions.find((item) => item.id === "node_plain")?.nodeId).toBe("node_plain")
    expect(availableSessions.sessions.find((item) => item.id === "ses_external")?.nodeId).toBeNull()
    const attached = await (await fetch(`${base}/sessions/ses_external/attach`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ categories: ["外部"] }),
    })).json() as { id: string; opencodeSessionId: string; categories: string[] }
    expect(attached.opencodeSessionId).toBe("ses_external")
    expect(attached.categories).toEqual(["外部"])
    expect((await (await fetch(`${base}/sessions/ses_external/attach`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).json() as { id: string }).id).toBe(attached.id)
    const workspace = await (await fetch(`${base}/workspaces`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "TUI test" }),
    })).json() as { id: string }
    await fetch(`${base}/workspaces/${workspace.id}/members`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: "node_plain" }),
    })
    const secondWorkspace = await (await fetch(`${base}/workspaces`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Selection target" }),
    })).json() as { id: string }
    const joined = await (await fetch(`${base}/workspaces/${secondWorkspace.id}/members`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: "node_plain", action: "join" }),
    })).json() as { workspacesOfNode: string[] }
    expect(joined.workspacesOfNode).toContain(workspace.id)
    expect(joined.workspacesOfNode).toContain(secondWorkspace.id)
    const forked = await (await fetch(`${base}/nodes/node_plain/fork`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).json() as { id: string; meta: Record<string, unknown>; categories: string[] }
    expect(forked.meta).toMatchObject({ model: { providerID: "demo", modelID: "beta" }, agent: "plan" })
    expect(forked.categories).toEqual(["前端", "API"])
    const graph = await (await fetch(`${base}/graph`)).json() as { members: Array<{ workspaceId: string; nodeId: string }> }
    expect(graph.members.some((member) => member.workspaceId === workspace.id && member.nodeId === forked.id)).toBe(true)
    const contextExport = await (await fetch(`${base}/nodes/node_plain/export`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageIds: ["plain_user"], mode: "context", workspaceId: workspace.id }),
    })).json() as { node: { id: string; categories: string[] }; exportedBy: string; count: number }
    expect(contextExport).toMatchObject({ exportedBy: "context", count: 1 })
    expect(contextExport.node.categories).toEqual(["前端", "API"])
    expect(seeds).toHaveLength(1)
    expect(seeds[0].noReply).toBe(true)
    expect(seeds[0].text).toContain("An ordinary user question should stay intact")
    const nativeExport = await (await fetch(`${base}/nodes/node_plain/export`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageIds: ["plain_user"], mode: "fork", workspaceId: workspace.id }),
    })).json() as { exportedBy: string; count: number }
    expect(nativeExport).toMatchObject({ exportedBy: "fork", count: 1 })
    expect(seeds).toHaveLength(1)
    const afterExport = await (await fetch(`${base}/graph`)).json() as { members: Array<{ workspaceId: string; nodeId: string }> }
    expect(afterExport.members.some((member) => member.workspaceId === workspace.id && member.nodeId === contextExport.node.id)).toBe(true)
    // 继承父节点：小上下文默认 fork；强制 seed 时写入带结构化标记的种子
    const inheritedFork = await (await fetch(`${base}/nodes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Inherit fork", inheritFromNodeId: "node_plain" }),
    })).json() as { meta: Record<string, unknown> }
    expect(inheritedFork.meta).toMatchObject({ forkedFrom: "node_plain" })
    const inheritedSeed = await (await fetch(`${base}/nodes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Inherit seed", inheritFromNodeId: "node_plain", inheritMode: "seed" }),
    })).json() as { meta: Record<string, unknown> }
    expect(inheritedSeed.meta).toMatchObject({ seededFrom: "node_plain" })
    expect(seeds.at(-1)?.text).toContain('<nodex-seed kind="inherit"')
    const promptsBeforeExcerpt = calls.length
    const excerpt = await fetch(`${base}/nodes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Excerpt", seed: "【摘录】a selected phrase", workspaceId: workspace.id, categories: ["摘录"] }),
    })
    expect(excerpt.status).toBe(201)
    expect((await excerpt.json() as { categories: string[] }).categories).toEqual(["摘录"])
    expect(seeds.at(-1)).toMatchObject({ noReply: true, text: "【摘录】a selected phrase" })
    const notebook = await (await fetch(`${base}/nodes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "notebook", title: "Notes", workspaceId: workspace.id }),
    })).json() as { id: string }
    const note = await (await fetch(`${base}/nodes/${notebook.id}/excerpt`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "a selected phrase", fromTitle: "Plain", fromNodeId: "node_plain", messageId: "m1", offset: 3 }),
    })).json() as { node: { meta: { doc: string } } }
    expect(note.node.meta.doc).toContain("a selected phrase")
    expect(note.node.meta.doc).not.toContain("> a selected phrase")
    expect(note.node.meta.doc).toContain('class="nodex-excerpt-src"')
    expect(note.node.meta.doc).toContain('data-nodex-mid="m1"')
    expect(note.node.meta.doc).toContain('data-nodex-offset="3"')
    expect(calls).toHaveLength(promptsBeforeExcerpt)
    const sumNotebook = await (await fetch(`${base}/nodes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "notebook", title: "未命名笔记本" }),
    })).json() as { id: string }
    await fetch(`${base}/nodes/${sumNotebook.id}/doc`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc: "# 会议\n记录 a selected phrase 要点" }),
    })
    const summaryResponse = await (await fetch(`${base}/nodes/${sumNotebook.id}/notebook-summary`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).json() as { summary: string; title: string; node: { title: string; summaries: Array<{ text: string; source: string }> } }
    expect(summaryResponse.summary).toBe("记录了选中的短语")
    expect(summaryResponse.title).toBe("摘录笔记")
    expect(summaryResponse.node.summaries.at(-1)).toMatchObject({ text: "记录了选中的短语", source: "ai" })
    expect((await fetch(`${base}/nodes/node_plain/notebook-summary`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).status).toBe(400)
    const emptyNotebook = await (await fetch(`${base}/nodes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "notebook", title: "空白笔记" }),
    })).json() as { id: string }
    expect((await fetch(`${base}/nodes/${emptyNotebook.id}/notebook-summary`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).status).toBe(400)
    const aiSettings = await (await fetch(`${base}/settings/ai`)).json() as { effectiveModel: string; hasApiKey: boolean; apiKeyMasked: string; apiKeySource: string }
    expect(aiSettings).toMatchObject({ effectiveModel: "test-model", hasApiKey: true, apiKeySource: "env" })
    expect(aiSettings.apiKeyMasked).not.toContain("test-key")
    const aiTest = await (await fetch(`${base}/settings/ai/test`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).json() as { ok: boolean; model: string }
    expect(aiTest).toMatchObject({ ok: true, model: "test-model" })
    const savedAi = await (await fetch(`${base}/settings/ai`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "custom-model", apiKey: "secret-value-123456" }),
    })).json() as { hasApiKey: boolean; apiKeyMasked: string; effectiveModel: string; apiKeySource: string }
    expect(savedAi).toMatchObject({ hasApiKey: true, effectiveModel: "custom-model", apiKeySource: "settings" })
    expect(savedAi.apiKeyMasked).not.toContain("secret-value-123456")
    const persistedAi = await (await fetch(`${base}/settings/ai`)).json() as { model: string; apiKeyMasked: string }
    expect(persistedAi.model).toBe("custom-model")
    expect(persistedAi.apiKeyMasked).not.toContain("secret-value-123456")
    const followUp = await fetch(`${base}/nodes/node_idea1/prompt`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "深入追问" }),
    })
    expect((await followUp.json() as { reply: string }).reply).toBe("deep result from node_idea1")
    const updatedResults = await (await fetch(`${base}/nodes/node_center/collaboration-results`)).json() as { workers: Array<{ nodeId: string; preview: string }> }
    expect(updatedResults.workers.find((worker) => worker.nodeId === "node_idea1")?.preview).toBe("deep result from node_idea1")
    expect((await (await fetch(`${base}/nodes/node_idea1`)).json() as { messages: Array<{ role: string; text: string }> }).messages.filter((message) => message.role === "user").at(-1)?.text).toBe("深入追问")
  } finally {
    server?.stop(true)
    fake.stop(true)
    rmSync(dir, { recursive: true, force: true })
    if (previous.port === undefined) delete process.env.NODEX_PORT; else process.env.NODEX_PORT = previous.port
    if (previous.data === undefined) delete process.env.NODEX_DATA_DIR; else process.env.NODEX_DATA_DIR = previous.data
    if (previous.base === undefined) delete process.env.OPENCODE_BASE_URL; else process.env.OPENCODE_BASE_URL = previous.base
    if (previous.aiBase === undefined) delete process.env.NODEX_AI_BASE_URL; else process.env.NODEX_AI_BASE_URL = previous.aiBase
    if (previous.aiKey === undefined) delete process.env.NODEX_AI_API_KEY; else process.env.NODEX_AI_API_KEY = previous.aiKey
    if (previous.aiModel === undefined) delete process.env.NODEX_AI_MODEL; else process.env.NODEX_AI_MODEL = previous.aiModel
  }
})
