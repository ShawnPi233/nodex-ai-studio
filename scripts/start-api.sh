#!/usr/bin/env bash
# 在后台启动 NodeX API（与调用终端解耦，避免随 shell 退出被杀）。
# OpenCode 连接策略见 scripts/lib.sh。
set -euo pipefail

NODEX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$NODEX_ROOT/scripts/lib.sh"
cd "$NODEX_ROOT"
mkdir -p runs

API_PORT="${NODEX_PORT:-4501}"
MODEL="${NODEX_DEFAULT_MODEL:-}"
BUN="$(nodex_bun)"
[[ -n "$BUN" ]] || { echo "[nodex] 未找到 bun：请安装 bun 或设置 NODEX_BUN"; exit 1; }

OC_BASE="$(nodex_ensure_opencode)" || { nodex_opencode_help; exit 1; }

stop_port() {
  local port="$1"
  local pids
  pids=$(ss -lptn "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)
  for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in $pids; do kill -KILL "$pid" 2>/dev/null || true; done
}
stop_port "$API_PORT"
pkill -9 -f "apps/api/src/server.ts" 2>/dev/null || true
sleep 1

setsid env \
  OPENCODE_BASE_URL="$OC_BASE" \
  NODEX_PORT="$API_PORT" \
  NODEX_DEFAULT_MODEL="$MODEL" \
  "$BUN" run "$NODEX_ROOT/apps/api/src/server.ts" \
  > "$NODEX_ROOT/runs/api.log" 2>&1 < /dev/null &

for _ in $(seq 1 40); do
  curl -sf -m 2 "http://127.0.0.1:$API_PORT/health" > /dev/null 2>&1 && break
  sleep 0.5
done

if curl -sf -m 3 "http://127.0.0.1:$API_PORT/health" > /dev/null 2>&1; then
  echo "[nodex] API 已启动 :$API_PORT（OpenCode: $OC_BASE）"
else
  echo "[nodex] API 启动失败，见 runs/api.log"
  tail -20 "$NODEX_ROOT/runs/api.log" || true
  exit 1
fi
