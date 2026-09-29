#!/usr/bin/env bash
# NodeX 共享脚本工具（被 dev.sh / start-api.sh / demo.sh 等 source）。
#
# 约定：
#   - 默认端口统一为 OpenCode 官方默认 4096（可用 NODEX_OC_PORT 覆盖）。
#   - 不写死用户绝对路径：配置目录用 XDG_CONFIG_HOME（缺省 $HOME/.config）。
#   - 运行时连接链：OPENCODE_BASE_URL → 探测本机已跑实例（attach 共用）
#     → PATH 中的 opencode 按 NODEX_OC_MODE 启动 → 都没有则返回失败，
#     由调用方提示安装 OpenCode（不静默失败）。

# 若调用方未设置 NODEX_ROOT，则依据本文件位置推导仓库根。
if [[ -z "${NODEX_ROOT:-}" ]]; then
  NODEX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

# 解析 bun 可执行文件：NODEX_BUN → PATH 中的 bun → 仓库内 .tools/bin/bun。
nodex_bun() {
  if [[ -n "${NODEX_BUN:-}" ]]; then printf '%s' "$NODEX_BUN"; return; fi
  if command -v bun >/dev/null 2>&1; then command -v bun; return; fi
  if [[ -x "$NODEX_ROOT/.tools/bin/bun" ]]; then printf '%s' "$NODEX_ROOT/.tools/bin/bun"; return; fi
  printf ''
}

# 默认 OpenCode 端口。
nodex_oc_port() { printf '%s' "${NODEX_OC_PORT:-4096}"; }

# 在给定端口列表中探测健康的本机 OpenCode，成功则打印 base URL。
nodex_detect_opencode() {
  local port
  for port in "$@"; do
    if curl -sf -m 2 "http://127.0.0.1:$port/global/health" >/dev/null 2>&1; then
      printf 'http://127.0.0.1:%s' "$port"
      return 0
    fi
  done
  return 1
}

# 确保有一个可用的 OpenCode，打印其 base URL；失败返回 1。
#   1) OPENCODE_BASE_URL 显式给出 → 直接用
#   2) 探测本机已跑实例 → attach（共用同一批 session）
#   3) PATH 中的 opencode → 按 NODEX_OC_MODE（默认 attach / 可选 isolated）启动
#   4) 都没有 → 返回 1（调用方负责提示安装）
nodex_ensure_opencode() {
  local port found
  port="$(nodex_oc_port)"

  if [[ -n "${OPENCODE_BASE_URL:-}" ]]; then
    printf '%s' "$OPENCODE_BASE_URL"
    return 0
  fi

  if found="$(nodex_detect_opencode "$port" 4096 4199)"; then
    printf '%s' "$found"
    return 0
  fi

  if ! command -v opencode >/dev/null 2>&1; then
    return 1
  fi

  mkdir -p "$NODEX_ROOT/runs"
  if [[ "${NODEX_OC_MODE:-attach}" == "isolated" ]]; then
    bash "$NODEX_ROOT/scripts/oc-env.sh" "$port" >"$NODEX_ROOT/runs/oc-isolated.log" 2>&1 &
  else
    ( cd "$NODEX_ROOT" && nohup opencode serve --port "$port" --hostname 127.0.0.1 \
        >"$NODEX_ROOT/runs/oc-attach.log" 2>&1 & )
  fi

  for _ in $(seq 1 60); do
    if found="$(nodex_detect_opencode "$port")"; then
      printf '%s' "$found"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# 打印安装引导（探测失败时调用）。
nodex_opencode_help() {
  cat <<'EOF'
[nodex] 未找到可用的 OpenCode Server，且 PATH 中没有 opencode 命令。

请任选一种方式：
  1) 安装 OpenCode 并启动 Server：
       opencode auth login
       opencode serve --port 4096
  2) 或用环境变量指向已在运行的实例：
       export OPENCODE_BASE_URL=http://127.0.0.1:4096

详见 README「快速开始 / 与 OpenCode 的边界」。
EOF
}
