#!/usr/bin/env bash
# 为 NodeX 启动一个隔离的 OpenCode Server。
#
# 安全约束：
#   - 只读复用用户已有的 OpenCode 配置（模型与凭据来源）。
#   - 数据与状态写入 NodeX 自己的 runs/ 目录，绝不写入用户的 OpenCode 目录。
#   - 不读取、不迁移、不删除用户的历史会话。
#
# 用法： source scripts/oc-env.sh && opencode serve --port 4199
#   或： bash scripts/oc-env.sh <port>

set -euo pipefail

NODEX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 复用用户配置（只读）；不写死绝对路径，遵循 XDG 约定。
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
OC_USER_CONFIG="${OPENCODE_CONFIG:-$XDG_CONFIG_HOME/opencode/opencode.json}"

# NodeX 私有数据/状态目录
export NODEX_OC_HOME="${NODEX_OC_HOME:-$NODEX_ROOT/runs/opencode-home}"
mkdir -p "$NODEX_OC_HOME/data" "$NODEX_OC_HOME/state"

# 隔离数据与状态，避免写入用户目录
export OPENCODE_CONFIG="$OC_USER_CONFIG"
export XDG_DATA_HOME="$NODEX_OC_HOME/data"
export XDG_STATE_HOME="$NODEX_OC_HOME/state"

# 用户可能设置了共享数据库目录；NodeX 必须指向自己的库，避免污染
unset OPENCODE_SHARED_DB_DIR
unset OPENCODE_PID

PORT="${1:-4096}"
echo "[nodex] OpenCode 隔离实例"
echo "[nodex]   配置(只读): $OPENCODE_CONFIG"
echo "[nodex]   数据(私有): $XDG_DATA_HOME"
echo "[nodex]   状态(私有): $XDG_STATE_HOME"
echo "[nodex]   端口: $PORT"

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  export NODEX_OC_PORT="$PORT"
else
  exec opencode serve --port "$PORT" --hostname 127.0.0.1
fi
