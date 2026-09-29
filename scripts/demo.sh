#!/usr/bin/env bash
# NodeX 可运行样例。
#
# 该脚本会：
#   1. 启动隔离的 OpenCode Server（不触碰用户的配置与会话）
#   2. 启动 NodeX API 与 Web 画布
#   3. 写入一组演示图谱数据（3 个工作区、含一个交叠节点、一个 Portal）
#   4. 打印画布地址与可复制的命令
#
# 用法：
#   bash scripts/demo.sh               # 完整样例（含真实模型对话）
#   bash scripts/demo.sh --no-model    # 不调用模型，仅验证图谱与路由
set -euo pipefail

NODEX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$NODEX_ROOT/scripts/lib.sh"
OC_PORT="$(nodex_oc_port)"
API_PORT="${NODEX_PORT:-4501}"
WEB_PORT="${NODEX_WEB_PORT:-4600}"
MODEL="${NODEX_DEFAULT_MODEL:-}"
BUN="$(nodex_bun)"
[[ -n "$BUN" ]] || { echo "[nodex] 未找到 bun：请安装 bun 或设置 NODEX_BUN"; exit 1; }
WITH_MODEL=1
[[ "${1:-}" == "--no-model" ]] && WITH_MODEL=0

cd "$NODEX_ROOT"
mkdir -p runs

log() { echo "[nodex] $*"; }

# ---------- 1. OpenCode 隔离实例 ----------
log "启动隔离的 OpenCode Server (:$OC_PORT)"
if curl -sf -m 2 "http://127.0.0.1:$OC_PORT/global/health" > /dev/null 2>&1; then
  log "  已有实例，复用"
else
  bash scripts/oc-env.sh "$OC_PORT" > runs/oc-isolated.log 2>&1 &
  for _ in $(seq 1 60); do
    curl -sf -m 2 "http://127.0.0.1:$OC_PORT/global/health" > /dev/null 2>&1 && break
    sleep 0.5
  done
fi
curl -sf -m 3 "http://127.0.0.1:$OC_PORT/global/health" > /dev/null \
  || { log "OpenCode Server 启动失败，见 runs/oc-isolated.log"; exit 1; }

# ---------- 2. 启动前清理旧进程与演示数据 ----------
stop_port() {
  local port="$1"
  local pids
  pids=$(ss -lptn "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)
  for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done
  # 等待端口真正释放，超过阈值则强制结束，避免复用旧进程
  for _ in $(seq 1 20); do
    ss -lptn "sport = :$port" 2>/dev/null | grep -q ":$port" || break
    sleep 0.25
  done
  for pid in $pids; do kill -KILL "$pid" 2>/dev/null || true; done
}
stop_port "$API_PORT"
stop_port "$WEB_PORT"
# 端口探测可能漏掉未绑定监听的残留进程，再按命令行兜底清理
pkill -9 -f "apps/api/src/server.ts" 2>/dev/null || true
pkill -9 -f "apps/web/src/dev.ts" 2>/dev/null || true
sleep 1
rm -f runs/graph.json runs/demo-report.json

# ---------- 3. NodeX API ----------
log "启动 NodeX API (:$API_PORT)"
OPENCODE_BASE_URL="http://127.0.0.1:$OC_PORT" \
NODEX_PORT="$API_PORT" \
NODEX_DEFAULT_MODEL="$MODEL" \
  nohup "$BUN" run apps/api/src/server.ts > runs/api.log 2>&1 &

for _ in $(seq 1 40); do
  curl -sf -m 2 "http://127.0.0.1:$API_PORT/health" > /dev/null 2>&1 && break
  sleep 0.5
done
curl -sf -m 3 "http://127.0.0.1:$API_PORT/health" > /dev/null \
  || { log "API 启动失败，见 runs/api.log"; exit 1; }

# ---------- 4. 写入演示数据 ----------
log "写入演示图谱"

# 4.1 三个工作区
WS_A=$(curl -s -X POST "http://127.0.0.1:$API_PORT/workspaces" -H 'Content-Type: application/json' \
  -d '{"name":"前端项目","systemPrompt":"你是前端项目助手，只关注 React 与组件设计。","color":"#6366f1"}')
WS_B=$(curl -s -X POST "http://127.0.0.1:$API_PORT/workspaces" -H 'Content-Type: application/json' \
  -d '{"name":"后端项目","systemPrompt":"你是后端项目助手，只关注 API 与数据库设计。","color":"#10b981"}')
WS_C=$(curl -s -X POST "http://127.0.0.1:$API_PORT/workspaces" -H 'Content-Type: application/json' \
  -d '{"name":"公共规范","systemPrompt":"你负责公共 API 契约与命名规范。","color":"#f59e0b"}')
WS_A_ID=$(echo "$WS_A" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
WS_B_ID=$(echo "$WS_B" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
WS_C_ID=$(echo "$WS_C" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

mknode() {
  curl -s -X POST "http://127.0.0.1:$API_PORT/nodes" -H 'Content-Type: application/json' \
    -d "{\"title\":\"$1\",\"workspaceId\":\"$2\"}" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])'
}

# 4.2 前端圈：2 个节点
FA=$(mknode "组件库选型" "$WS_A_ID")
FB=$(mknode "状态管理方案" "$WS_A_ID")
# 4.3 后端圈：2 个节点
BA=$(mknode "REST 接口设计" "$WS_B_ID")
BB=$(mknode "数据库索引优化" "$WS_B_ID")
# 4.4 交叠节点：同时属于前端与公共规范
OV=$(mknode "API 契约对齐" "$WS_A_ID")
curl -s -X POST "http://127.0.0.1:$API_PORT/workspaces/$WS_C_ID/members" -H 'Content-Type: application/json' \
  -d "{\"nodeId\":\"$OV\",\"action\":\"join\"}" > /dev/null
# 4.5 公共规范圈：1 个纯规范节点
SPEC=$(mknode "命名与版本规范" "$WS_C_ID")
# 4.6 圈外独立节点（不属于任何工作区）
OUT=$(mknode "临时调研笔记" "")

# 4.7 建立 Portal：圈外节点只以摘要快照进入前端圈
curl -s -X POST "http://127.0.0.1:$API_PORT/links" -H 'Content-Type: application/json' \
  -d "{\"kind\":\"portal\",\"from\":\"$FA\",\"to\":\"$OUT\",\"snapshot\":\"外部调研结论：优先选择轻量方案，避免引入重型依赖。\"}" > /dev/null

# 4.8 为交叠节点生成摘要（供软加载/Potal 使用；失败不影响样例）
curl -s -m 30 -X POST "http://127.0.0.1:$API_PORT/nodes/$OV/summarize" > /dev/null 2>&1 || true

# 等待图谱落盘，确保自检读到完整数据
for _ in $(seq 1 40); do
  n=$(curl -s -m 5 "http://127.0.0.1:$API_PORT/graph" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["nodes"]))' 2>/dev/null || echo 0)
  [[ "$n" == "7" ]] && break
  sleep 0.25
done

cat > runs/demo-ids.env <<EOF
WS_A_ID=$WS_A_ID
WS_B_ID=$WS_B_ID
WS_C_ID=$WS_C_ID
FA=$FA
FB=$FB
BA=$BA
BB=$BB
OV=$OV
SPEC=$SPEC
OUT=$OUT
EOF

# ---------- 5. Web 画布 ----------
log "启动 Web 画布 (:$WEB_PORT)"
NODEX_WEB_PORT="$WEB_PORT" \
NODEX_API="http://127.0.0.1:$API_PORT" \
  nohup "$BUN" run apps/web/src/dev.ts > runs/web.log 2>&1 &
sleep 2

# ---------- 6. 样例自检 ----------
echo
log "样例自检"
bash scripts/demo-check.sh "$API_PORT" "$WITH_MODEL" || true

echo
echo "=============================================================="
echo "  NodeX 样例已就绪"
echo "=============================================================="
echo "  可视化画布:  http://127.0.0.1:$WEB_PORT"
echo ""
echo "  画布上你可以："
echo "    · 看到 3 个半透明工作区气泡，其中「API 契约对齐」位于交叠区（黄色描边）"
echo "    · 单击节点 → 右侧面板可提问、生成摘要、删除"
echo "    · 拖动节点调整布局"
echo "    · 双击节点 → 在「前端项目」中移入/移出工作区"
echo "    · 顶部按钮新建节点 / 工作区 / 重置视图"
echo ""
echo "  命令行体验三层上下文路由："
echo "    curl -s http://127.0.0.1:$API_PORT/nodes/$FA/context | python3 -m json.tool"
echo "    curl -s 'http://127.0.0.1:$API_PORT/graph' | python3 -m json.tool"
echo ""
if [[ "$WITH_MODEL" == "1" ]]; then
echo "  真实模型对话（会调用 OpenCode）："
echo "    curl -s -X POST http://127.0.0.1:$API_PORT/nodes/$FA/prompt \\"
echo "      -H 'Content-Type: application/json' -d '{\"text\":\"用一句话说明这个项目在做什么\"}'"
else
echo "  （以 --no-model 启动，跳过模型调用）"
fi
echo ""
echo "  停止：bash scripts/demo-stop.sh"
echo "=============================================================="
