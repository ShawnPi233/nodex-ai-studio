#!/usr/bin/env bash
# 一键启动 NodeX 开发环境（OpenCode + API + Web）。
# OpenCode 连接策略见 scripts/lib.sh：OPENCODE_BASE_URL → 探测已跑实例（attach 共用）
# → PATH 中的 opencode 按 NODEX_OC_MODE 启动（默认 attach，isolated 可选）。
set -euo pipefail

NODEX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$NODEX_ROOT/scripts/lib.sh"

API_PORT="${NODEX_PORT:-4501}"
WEB_PORT="${NODEX_WEB_PORT:-4600}"
MODEL="${NODEX_DEFAULT_MODEL:-}"
BUN="$(nodex_bun)"
[[ -n "$BUN" ]] || { echo "[nodex] 未找到 bun：请安装 bun 或设置 NODEX_BUN"; exit 1; }

cd "$NODEX_ROOT"
mkdir -p runs

OC_BASE="$(nodex_ensure_opencode)" || { nodex_opencode_help; exit 1; }
echo "[nodex] 使用 OpenCode: $OC_BASE（NODEX_OC_MODE=${NODEX_OC_MODE:-attach}）"

echo "[nodex] 启动 API (:$API_PORT)"
OPENCODE_BASE_URL="$OC_BASE" \
NODEX_PORT="$API_PORT" \
NODEX_DEFAULT_MODEL="$MODEL" \
  nohup "$BUN" run apps/api/src/server.ts > runs/api.log 2>&1 &
sleep 3

echo "[nodex] 启动 Web (:$WEB_PORT)"
NODEX_WEB_PORT="$WEB_PORT" \
NODEX_API="http://127.0.0.1:$API_PORT" \
  nohup "$BUN" run apps/web/src/dev.ts > runs/web.log 2>&1 &
sleep 2

echo
echo "[nodex] 就绪"
echo "  画布:     http://127.0.0.1:$WEB_PORT"
echo "  API:      http://127.0.0.1:$API_PORT/health"
echo "  OpenCode: $OC_BASE"
echo "  日志:     runs/{api,web}.log"
echo
echo "停止： pkill -f 'apps/api/src/server.ts'; pkill -f 'apps/web/src/dev.ts'"
