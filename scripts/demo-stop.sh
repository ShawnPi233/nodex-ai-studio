#!/usr/bin/env bash
# 停止 NodeX 样例进程（不影响用户自己的 OpenCode 进程）。
set -uo pipefail

NODEX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$NODEX_ROOT/scripts/lib.sh"
OC_PORT="$(nodex_oc_port)"
API_PORT="${NODEX_PORT:-4501}"
WEB_PORT="${NODEX_WEB_PORT:-4600}"

stop_port() {
  local port="$1"
  local pids
  pids=$(ss -lptn "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)
  for pid in $pids; do
    echo "[nodex] 停止 :$port (pid=$pid)"
    kill -TERM "$pid" 2>/dev/null || true
  done
}

stop_port "$WEB_PORT"
stop_port "$API_PORT"
stop_port "$OC_PORT"
sleep 1

echo "[nodex] 已停止。演示数据保留在 runs/graph.json"
