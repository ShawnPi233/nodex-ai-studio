# NodeX for VS Code

在 VS Code 里使用 NodeX 图谱画布工作台。这是一个**薄壳**扩展：
它复用（或在需要时拉起）NodeX 本地服务，并在 webview 中内嵌官方网页画布，
因此能力与网页端保持一致：文件侧栏 / 文件预览 / 工作区目录等文件管理功能在扩展内同样可用。

## 使用

1. 启动 OpenCode Server（`opencode serve`），或在设置里指定 `nodex.opencodeUrl`。
2. 活动栏点击 NodeX 图标，或在命令面板运行 `NodeX: 在编辑器打开画布`。

扩展会先探测本机已运行的 NodeX 网页服务（默认端口 4600 / 4627）并复用；
找不到且 `nodex.autoStart` 为真时，会用 bun 拉起 `apps/api` 与 `apps/web`。

命令：

- `NodeX: 在编辑器打开画布`：在编辑器区打开完整画布。
- `NodeX: 在浏览器打开`：用系统浏览器打开同一实例。
- `NodeX: 重启本地服务`：停掉由扩展拉起的服务并重新探测 / 启动。
- `NodeX: 显示服务状态`：显示当前使用的地址。

## 设置

| 设置 | 说明 |
| --- | --- |
| `nodex.webUrl` | 已运行的 NodeX 网页地址；留空则按端口探测或自动拉起。 |
| `nodex.repoPath` | NodeX 仓库根目录；自动拉起时使用，留空则尝试扩展安装位置与当前工作区。 |
| `nodex.bunPath` | bun 可执行文件路径；留空则用 PATH 中的 bun 或仓库内 `.tools/bin/bun`。 |
| `nodex.opencodeUrl` | OpenCode Server 地址；留空则探测 4096 / 4199。 |
| `nodex.autoStart` | 找不到运行中的实例时是否自动拉起（默认 true）。 |

## 开发

```bash
cd apps/vscode
bun install
bun run build        # 用 bun 打包到 dist/extension.js
bun run watch        # 监听重建
bun run package      # 生成 .vsix
```

在 VS Code 中按 `F5`（Run Extension）加载开发版扩展。
