# AGENTS.md

Instructions for AI coding agents working in this repository. User-facing onboarding lives in [README.md](README.md) (Chinese) and [README.en.md](README.en.md) (English).

## What this is

NodeX is a graph-canvas AI conversation and knowledge system: every node is an OpenCode session (or a Markdown notebook), and links, pages and context routing decide what each prompt can see. The execution layer is entirely [OpenCode](https://opencode.ai).

Stack: Bun + TypeScript (backend), plain JS + DOM/Canvas (frontend in `apps/web/public`, no build step).

## Repository layout

```text
apps/api/                 NodeX backend (HTTP API, graph store, context-routing scheduling, collaboration)
  src/server.ts           Route entrypoint; all HTTP endpoints
  src/store.ts            graph.json persistence
  src/runtime-status.ts   Session activity status
  src/collaboration.ts    Multi-agent collaboration orchestration
  src/ai.ts               Direct OpenAI-compatible calls (summaries, etc.)
apps/web/
  src/dev.ts              Dev server + /api reverse proxy + /vendor static assets
  public/                 Pure static frontend (index.html / app.js / *.js modules)
apps/vscode/              VS Code extension (thin shell: embeds web canvas + probes/starts local service)
  src/extension.ts        Activation, webview view and commands
  src/server.ts           Reuse or start NodeX API + Web
  src/webview.ts          Outer HTML / CSP for the embedded iframe
packages/domain/          Node / Link / Workspace domain models (pure functions)
packages/context-router/  Three-layer context routing
packages/runtime-opencode/OpenCode SDK adapter (the single runtime abstraction)
scripts/                  dev.sh / demo.sh / lib.sh / oc-env.sh etc.
```

## Common commands

```bash
bun install
bash scripts/dev.sh          # start OpenCode + API + Web
bun run api                  # API only (default :4501)
bun run web                  # Web only (default :4600)
bun test                     # unit tests (local only, see below)
```

## Boundary with OpenCode (important invariants)

- **Only talk to OpenCode through its Server's HTTP / OpenAPI / SDK.** Do not fork its UI, touch its install directory, or write user config.
- `AgentRuntime` (`packages/runtime-opencode/src/runtime.ts`) is the single abstraction point;
  the graph layer only ever sees **translated NodeX-internal events** (`packages/runtime-opencode/src/events.ts`).
  **Never** leak OpenCode event names into `apps/api`.
- When adding an OpenCode event: add a branch to `translate()` in `events.ts`, add tests, and update `rawSessionId` if needed.
- NodeX persists its own graph (`runs/graph.json`, gitignored) and only references `opencode_session_id`.
- Supports OpenCode `1.17.0` – `2.0.0` (exclusive). Run the contract tests after changing the adapter.

Connection strategy (`scripts/lib.sh`): `OPENCODE_BASE_URL` → probe a local running instance (attach & share)
→ `opencode` on `PATH` (per `NODEX_OC_MODE`) → error with an install hint if none is found.

## Development conventions

- Backend and frontend are intentionally **dependency-light**: the frontend pulls in no framework or bundler, keeping `public/` runnable as-is.
- Comments and user-facing strings are **Chinese**, matching existing files; give public functions a brief purpose comment.
- Keep pure geometry / pure logic decoupled from the DOM (e.g. `public/graph-layout.js`, `packages/domain`) so it stays unit-testable.
- Frontend static changes only need a refresh; changes to `apps/web/src/dev.ts` or `apps/api` require restarting the relevant process.
- Default ports: OpenCode `4096`, API `4501`, Web `4600`; override with `NODEX_OC_PORT` / `NODEX_PORT` / `NODEX_WEB_PORT`.
- **Host adaptation**: the web app detects being embedded in VS Code via `?host=vscode`, which hides the file sidebar and file preview (the `html[data-host="vscode"]` rules in `index.html` plus `IS_VSCODE_HOST` in `app.js`). Follow this marker for new host adaptations and never change the standalone web app's default behavior for VS Code.
- The VS Code extension is deliberately a "thin shell": it does not bundle the web app into the extension but embeds the local service URL, avoiding a fork from the web app. Build/packaging is documented in `apps/vscode/README.md` (packaged with bun; on Node 18 run `vsce` via bun).

## What must not be committed

The following are **kept local and not published in the public repo**, excluded via `.gitignore`. Do not `git add -f` them:

- Design / process docs: `CONTEXT.md`, `docs/`
- Tests: `**/test/`, `**/*.test.ts`, `**/*.test.js`
- Runtime probe scripts: `packages/runtime-opencode/scripts/`
- Runtime artifacts and secrets: `runs/`, `test-data/`, `.env*`, `node_modules/`, `.tools/`

Before adding a new file, decide whether it is "product source / user-facing docs" or "internal process material"; the latter belongs in `.gitignore` as well.
