<p align="center">
  <img src="statics/images/logo/nodex.svg" alt="NodeX" width="320" />
</p>

<h1 align="center">NodeX</h1>

<p align="center">用图形画布组织 AI 对话与知识。</p>

<p align="center">
  <a href="README.md">中文</a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/ShawnPi233/nodex-ai-studio/actions/workflows/ci.yml"><img src="https://github.com/ShawnPi233/nodex-ai-studio/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#接入-opencode">接入 OpenCode</a> ·
  <a href="#架构">架构</a> ·
  <a href="#开发">开发</a> ·
  <a href="#许可证">许可证</a>
</p>

---

NodeX 把每个 AI 会话变成一个**画布节点**：连线表示引用与派生，页面用于分组，上下文路由决定每次提问会把哪些内容送进模型。模型接入、工具、权限与 MCP 全部复用 [OpenCode](https://opencode.ai)，不重复造轮子。

<p align="center">
  <img src="statics/images/demo/nodex%20demo.gif" alt="NodeX 演示" width="880" />
</p>

<p align="center">
  <img src="statics/images/demo/nodex%20demo2.gif" alt="NodeX 演示 2" width="880" />
</p>

<p align="center"><a href="https://github.com/ShawnPi233/nodex-ai-studio/releases/download/demo-v1/nodex-demo.mp4">▶ 观看完整演示视频（6.5 分钟，Release 附件）</a></p>

## 特性

- **图形画布**：节点 / 连线 / 页面 / 圈选，缩放平移稳定，位置本地与服务端双重持久化。
- **会话节点**：流式输出、可折叠思考、工具失败提示、`question` 问答、双 Esc 中断、原生 fork 与摘要。
- **笔记本节点**：Markdown 草稿 + AI 摘要，可与会话互相摘录并保留来源。
- **上下文路由**：硬加载 / 同工作区检索 / Portal 快照三层，隔离且可解释。
- **多 Agent 协作**：三省六部、头脑风暴、辩论赛等模板，批量编排子会话并汇总。
- **文件与工作区**：目录树、Monaco 预览 / 编辑、按会话分组的产出文件。
- **与 OpenCode 共用会话**：`attach` 模式下 TUI 与画布看到的是同一批 session。

## 环境要求

- [Bun](https://bun.sh)（也可用仓库内 `.tools/bin/bun`）
- 一个可用的 **OpenCode Server**（必需）。NodeX 自身不含模型能力：没有 OpenCode 时只能跑 `scripts/demo.sh --no-model` 的离线演示，真实对话需要先安装 OpenCode 并完成一次 `opencode auth login`。

## 快速开始

```bash
git clone https://github.com/ShawnPi233/nodex-ai-studio.git nodex && cd nodex
bun install
```

### 方式 A：已装好 / 正在运行 OpenCode

NodeX 会自动发现并附着到本机已运行的 OpenCode（默认探测 4096 / 4199），与终端 TUI 共用同一批 session：

```bash
bash scripts/dev.sh
```

打开 <http://127.0.0.1:4600>。想指定实例时：

```bash
export OPENCODE_BASE_URL=http://127.0.0.1:4096
bash scripts/dev.sh
```

### 方式 B：从未用过 OpenCode

1. 按官方文档安装 OpenCode 并登录一次（凭据由 OpenCode 管理）：

   ```bash
   opencode auth login
   ```

2. 启动 Server（NodeX 需要时也会自行拉起）：

   ```bash
   opencode serve --port 4096
   ```

3. 回到仓库启动 NodeX：

   ```bash
   bash scripts/dev.sh
   ```

`scripts/dev.sh` 的连接顺序：`OPENCODE_BASE_URL` → 探测本机实例（附着共用）→ `PATH` 中的 `opencode`（按 `NODEX_OC_MODE`，默认 `attach`）→ 都没有则报错提示安装。

### 秒级体验（不调用模型）

```bash
bash scripts/demo.sh --no-model   # 隔离 OpenCode，写入演示图谱
bash scripts/demo-stop.sh         # 停止
```

> 样例脚本依赖 `bash`、`curl`，自检额外用到 `python3`。

## 接入 OpenCode

NodeX 只通过 OpenCode Server 的 HTTP / OpenAPI 与 SDK 交互，**不修改你的 OpenCode 安装与配置**，自己持久化 `Node` / `Workspace` / `Link` / 摘要，仅引用 `opencode_session_id`。

| 模式 | 行为 | 数据落点 |
| --- | --- | --- |
| `attach`（默认） | 复用 / 拉起你的 OpenCode，TUI 与 NodeX **共享同一批 session** | 你的 OpenCode 数据目录 |
| `isolated` | 独立实例，只读复用用户配置、不写用户目录 | `runs/opencode-home/` |

```bash
NODEX_OC_MODE=isolated bash scripts/dev.sh   # 切到隔离模式
```

`OPENCODE_BASE_URL` 显式给出时优先。完整配置见 [`.env.example`](.env.example)。

## VS Code 扩展

`apps/vscode/` 是一个薄壳扩展：复用（或按需拉起）NodeX 本地服务，在 webview 中内嵌网页画布，能力与网页端一致，文件侧栏 / 文件预览 / 工作区目录等文件管理功能在扩展内同样可用。

```bash
cd apps/vscode
bun install
bun run package        # 生成 nodex-vscode-*.vsix
```

安装后点击活动栏的 NodeX 图标，或运行命令 `NodeX: 在编辑器打开画布`。扩展会先探测本机已运行的 NodeX 网页服务（默认 4600 / 4627）并复用，找不到且 `nodex.autoStart` 为真时自动拉起。详见 [`apps/vscode/README.md`](apps/vscode/README.md)。

## 模型与 AI 设置

- 模型清单来自 OpenCode 当前连接的 provider（`/config/providers`），NodeX 不维护模型表、不写你的 OpenCode 配置。优先级：请求参数 > 节点 `meta.model` > NodeX 全局设置 > OpenCode 默认。
- 笔记本摘要、节点元数据、选中文本改写等轻量能力由 NodeX 直连 OpenAI 兼容接口，可在界面「AI 设置」中配置地址、模型与 Key（默认 `https://api.openai.com/v1` / `gpt-4o-mini`，需要你自己的 Key；未配置时这些功能不可用，不影响会话本身）。
- **密钥隔离**：API Key 只存在本机数据目录的 `graph.json`（`runs/` 已 gitignore，`NODEX_DATA_DIR` 可改），源码与仓库不含密钥，接口只返回脱敏值。

## 架构

```text
nodex/
├── apps/
│   ├── api/                 NodeX 后端：图谱 API、上下文路由、运行时调度
│   ├── web/                 NodeX 前端：图形画布（public/ 为纯静态资源）
│   └── vscode/              VS Code 扩展：内嵌网页画布的薄壳
├── packages/
│   ├── domain/              Node / Link / Workspace 领域模型
│   ├── runtime-opencode/    OpenCode SDK 适配器（唯一运行时抽象点）
│   └── context-router/      三层上下文路由
└── scripts/                 启动 / 样例 / 隔离环境脚本
```

`AgentRuntime`（`packages/runtime-opencode/src/runtime.ts`）是唯一抽象点，向图谱层只输出已翻译的 NodeX 内部事件，未来可替换其他运行时。

## 开发

```bash
bash scripts/dev.sh          # OpenCode + API + Web 一起起
bun run api                  # 只起 API
bun run web                  # 只起 Web（含 /api 反向代理）
bun test                     # 单元与适配器契约测试
```

静态文件与 `/api` 代理响应带 `Cache-Control: no-store`，刷新即可看到最新改动。

## 兼容性

- 当前在 OpenCode `1.17.x` 上完整验证。适配器按 `1.17.0` ~ `2.0.0`（不含）做版本区间检查，`GET /health` 的 `opencode.supported` 会标记当前实例是否在区间内，超出会在启动日志告警；区间之外不保证可用。
- 升级 OpenCode 前先跑适配器契约测试：`bun test`。

## 致谢

- [OpenCode](https://opencode.ai) — 执行层与模型接入的基石，NodeX 直接复用其 Server / SDK。
- [OpenChamber](https://github.com/openchamber/openchamber) — VS Code 内嵌 AI 工作台的先例，为扩展形态提供了参考。
- [PiX](https://github.com/huang-sh/PiX) — 在 runtime 集成、互操作设计、AGENTS 工作纪律和单会话分支对比方面提供了有价值的参考。

## 许可证

[MIT](LICENSE)
