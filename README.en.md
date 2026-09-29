<p align="center">
  <img src="statics/images/logo/nodex.svg" alt="NodeX" width="320" />
</p>

<h1 align="center">NodeX</h1>

<p align="center">Organize AI conversations and knowledge on a graph canvas.</p>

<p align="center">
  <a href="README.md">中文</a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#connecting-to-opencode">Connecting to OpenCode</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#development">Development</a> ·
  <a href="#license">License</a>
</p>

---

NodeX turns every AI session into a **canvas node**: links express references and derivations, pages group nodes, and context routing decides what actually reaches the model on each turn. Model access, tools, permissions and MCP are all delegated to [OpenCode](https://opencode.ai) — no wheel is reinvented.

<p align="center">
  <img src="statics/images/demo/nodex%20demo.gif" alt="NodeX demo" width="880" />
</p>

<p align="center">
  <img src="statics/images/demo/nodex%20demo2.gif" alt="NodeX demo 2" width="880" />
</p>

<p align="center"><a href="statics/videos/nodex%20demo.mp4">▶ Watch the full demo video</a></p>

## Features

- **Graph canvas**: nodes / links / pages / selection, stable zoom & pan, positions persisted locally and server-side.
- **Session nodes**: streaming output, collapsible thinking, tool-failure notices, `question` prompts, double-Esc interrupt, native fork and summaries.
- **Notebook nodes**: Markdown scratchpad + AI summary, with cross-quoting between sessions and notebooks that keeps provenance.
- **Context routing**: hard-load / same-workspace retrieval / Portal snapshots — isolated and explainable.
- **Multi-agent collaboration**: templates such as Three Departments & Six Ministries, brainstorming and debates, orchestrating sub-sessions and aggregating results.
- **Files & workspaces**: directory tree, Monaco preview/edit, outputs grouped by session.
- **Shared sessions with OpenCode**: in `attach` mode the TUI and the canvas see the same sessions.

## Requirements

- [Bun](https://bun.sh) (or the bundled `.tools/bin/bun`)
- A reachable **OpenCode Server** (see below)

## Quick Start

```bash
git clone https://github.com/ShawnPi233/nodex-ai-studio.git nodex && cd nodex
bun install
```

### Option A: OpenCode already installed / running

NodeX automatically discovers and attaches to a local OpenCode instance (probes 4096 / 4199 by default) and shares its sessions with your terminal TUI:

```bash
bash scripts/dev.sh
```

Then open <http://127.0.0.1:4600>. To target a specific instance:

```bash
export OPENCODE_BASE_URL=http://127.0.0.1:4096
bash scripts/dev.sh
```

### Option B: Never used OpenCode before

1. Install OpenCode per its docs and log in once (credentials are managed by OpenCode):

   ```bash
   opencode auth login
   ```

2. Start the server (NodeX will also start it on demand):

   ```bash
   opencode serve --port 4096
   ```

3. Start NodeX from the repo:

   ```bash
   bash scripts/dev.sh
   ```

`scripts/dev.sh` resolves the connection in this order: `OPENCODE_BASE_URL` → probe a local instance (attach & share) → `opencode` on `PATH` (mode set by `NODEX_OC_MODE`, default `attach`) → otherwise fail with an install hint.

### Instant demo (no model calls)

```bash
bash scripts/demo.sh --no-model   # isolated OpenCode, seeds a demo graph
bash scripts/demo-stop.sh         # stop
```

> The demo scripts need `bash` and `curl`; the self-check also uses `python3`.

## Connecting to OpenCode

NodeX talks to OpenCode only through the Server's HTTP / OpenAPI and SDK. It **never modifies your OpenCode installation or config**; it persists `Node` / `Workspace` / `Link` / summaries itself and only references `opencode_session_id`.

| Mode | Behavior | Data location |
| --- | --- | --- |
| `attach` (default) | Reuse / start your OpenCode; TUI and NodeX **share the same sessions** | Your OpenCode data directory |
| `isolated` | Standalone instance; reads your config but never writes your directory | `runs/opencode-home/` |

```bash
NODEX_OC_MODE=isolated bash scripts/dev.sh   # switch to isolated mode
```

An explicit `OPENCODE_BASE_URL` takes precedence. See [`.env.example`](.env.example) for all options.

## VS Code Extension

`apps/vscode/` is a thin-shell extension: it reuses (or starts on demand) the local NodeX service and embeds the web canvas in a webview, so canvas capabilities match the web app; the file sidebar / preview are delegated to the editor itself.

```bash
cd apps/vscode
bun install
bun run package        # produces nodex-vscode-*.vsix
```

After installing, click the NodeX icon in the activity bar or run the command `NodeX: Open Canvas in Editor`. The extension first probes a running NodeX web service (ports 4600 / 4627) and reuses it; if none is found and `nodex.autoStart` is true, it starts one. See [`apps/vscode/README.md`](apps/vscode/README.md).

## Models & AI Settings

- The model list comes from the provider currently connected to OpenCode (`/config/providers`); NodeX keeps no model table and never writes your OpenCode config. Precedence: request params > node `meta.model` > NodeX global setting > OpenCode default.
- Lightweight features such as notebook summaries, node metadata and selected-text rewriting call an OpenAI-compatible endpoint directly; configure the base URL, model and key under "AI Settings" (default model: `gpt-6-luna`).
- **Secret isolation**: the API key lives only in `graph.json` in the local data directory (`runs/` is gitignored; override with `NODEX_DATA_DIR`). No secrets in the source or repo, and APIs return redacted values only.

## Architecture

```text
nodex/
├── apps/
│   ├── api/                 NodeX backend: graph API, context routing, runtime scheduling
│   ├── web/                 NodeX frontend: graph canvas (public/ is pure static assets)
│   └── vscode/              VS Code extension: thin shell embedding the web canvas
├── packages/
│   ├── domain/              Node / Link / Workspace domain models
│   ├── runtime-opencode/    OpenCode SDK adapter (the single runtime abstraction)
│   └── context-router/      Three-layer context routing
└── scripts/                 Startup / demo / isolated-environment scripts
```

`AgentRuntime` (`packages/runtime-opencode/src/runtime.ts`) is the single abstraction point; it emits only translated NodeX-internal events to the graph layer, so the runtime can be swapped without touching the graph layer.

## Development

```bash
bash scripts/dev.sh          # OpenCode + API + Web together
bun run api                  # API only
bun run web                  # Web only (with /api reverse proxy)
```

Static files and `/api` proxy responses are served with `Cache-Control: no-store`, so a refresh picks up the latest changes.

## Compatibility

- Supports OpenCode `1.17.0` – `2.0.0` (exclusive). `opencode.supported` in `GET /health` flags whether the current instance is in range; out-of-range logs a startup warning.
- Run the runtime adapter contract tests before upgrading OpenCode.

## Acknowledgements

- [OpenCode](https://opencode.ai) — the foundation for execution and model access; NodeX reuses its Server / SDK directly.
- [OpenChamber](https://github.com/openchamber/openchamber) — a precedent for an AI workbench embedded in VS Code; informed the extension's shape.
- [PiX](https://github.com/huang-sh/PiX) — a useful reference for runtime integration, interoperability, AGENTS practices and single-session branch comparison.

## License

[MIT](LICENSE)
