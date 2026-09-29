#!/usr/bin/env bash
# 样例自检：验证图谱结构、三层路由与隔离行为，并打印可读报告。
set -euo pipefail

API_PORT="${1:-4501}"
WITH_MODEL="${2:-1}"
API="http://127.0.0.1:$API_PORT"

# shellcheck disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/runs/demo-ids.env"

phy() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1"; }

PASS=0
FAIL=0
ok()   { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }
assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  [[ "$haystack" == *"$needle"* ]] && ok "$name" || bad "$name（未找到: $needle）"
}

echo "--------------------------------------------------------------"
echo " NodeX 样例自检"
echo "--------------------------------------------------------------"

# 1. 图谱结构
echo "[1] 图谱结构"
GRAPH=$(curl -s -m 15 "$API/graph")
NODE_COUNT=$(echo "$GRAPH" | phy "len(d['nodes'])")
WS_COUNT=$(echo "$GRAPH" | phy "len(d['workspaces'])")
echo "      节点数=$NODE_COUNT 工作区数=$WS_COUNT"
[[ "$NODE_COUNT" == "7" ]] && ok "7 个演示节点已创建" || bad "节点数应为 7，实际 $NODE_COUNT"
echo "      节点: $(echo "$GRAPH" | phy "[n['title'] for n in d['nodes']]")"
[[ "$WS_COUNT" == "3" ]] && ok "3 个工作区已创建" || bad "工作区数应为 3，实际 $WS_COUNT"

# 2. 交叠区识别
echo "[2] 交叠区（多工作区归属）"
OV_WS=$(curl -s -m 15 "$API/nodes/$OV/context" | phy "d['workspaces']")
echo "      「API 契约对齐」归属: $OV_WS"
assert_contains "交叠节点同时属于前端与公共规范" "$OV_WS" "$WS_A_ID"
assert_contains "交叠节点同时属于公共规范" "$OV_WS" "$WS_C_ID"

# 3. 工作区背景注入 + 自身不重复注入
echo "[3] 上下文路由：工作区背景，激活节点自身不重复注入"
CTX_FA=$(curl -s -m 20 "$API/nodes/$FA/context")
assert_contains "注入前端工作区 System Prompt" "$CTX_FA" '前端项目助手'
SELF_FA=$(echo "$CTX_FA" | phy "[c['nodeId'] for c in d['chunks'] if c['nodeId']=='$FA']")
[[ "$SELF_FA" == "[]" ]] && ok "激活节点自身不再硬加载（已在会话历史）" || bad "激活节点不应自注入"

# 4. 工作区隔离
echo "[4] 工作区隔离"
CTX_FA_NODES=$(echo "$CTX_FA" | phy "[c['nodeId'] for c in d['chunks']]")
if [[ "$CTX_FA_NODES" == *"$BA"* || "$CTX_FA_NODES" == *"$BB"* ]]; then
  bad "后端节点不应进入前端圈的上下文"
else
  ok "后端节点未进入前端圈上下文"
fi
if [[ "$CTX_FA_NODES" == *"$OUT"* ]]; then
  echo "      圈外节点以 Portal 形式进入（tier=portal）"
fi

# 5. Portal 只传快照
echo "[5] Portal 单向快照"
PORTAL=$(echo "$CTX_FA" | phy "[c for c in d['chunks'] if c['tier']=='portal']")
if [[ "$PORTAL" == *"$OUT"* ]]; then
  ok "圈外节点通过 Portal 进入上下文"
  assert_contains "Portal 携带摘要版本" "$PORTAL" "summaryVersion"
else
  bad "Portal 链路未生效"
fi
GRAPH_OUT=$(curl -s -m 15 "$API/graph" | phy "len([l for l in d['links'] if l['kind']=='portal' and l.get('snapshot')])")
[[ "$GRAPH_OUT" == "1" ]] && ok "Portal 快照已持久化" || bad "Portal 快照缺失"

# 6. 预算裁剪
# 激活节点自身不再硬加载，可被裁剪的是 portal 快照：budget=1 时必然放不下。
echo "[6] 预算裁剪（portal 受预算约束）"
TIGHT_JSON=$(curl -s -m 20 "$API/nodes/$FA/context?budget=1")
TIGHT=$(echo "$TIGHT_JSON" | phy "len(d['dropped'])")
if [[ "$TIGHT" != "0" ]]; then
  ok "小预算下产生 dropped（$TIGHT 项）"
else
  bad "预算裁剪未生效"
fi

# 7. 真实模型对话
if [[ "$WITH_MODEL" == "1" ]]; then
  echo "[7] 真实模型对话（含上下文注入）"
  REPLY=$(curl -s -m 90 -X POST "$API/nodes/$FA/prompt" -H 'Content-Type: application/json' \
    -d '{"text":"用一句话说明你在协助什么项目"}' 2>/dev/null || echo '{"error":"timeout"}')
  if [[ "$REPLY" == *'"reply"'* ]]; then
    ok "模型已返回"
    echo "      回复: $(echo "$REPLY" | phy "d['reply'][:160]")"
    echo "      上下文层级: $(echo "$REPLY" | phy "[f\"{c['nodeId']}:{c['tier']}\" for c in d['context']['tiers']]")"
  else
    bad "模型调用失败（检查 NODEX_DEFAULT_MODEL 与凭据）"
  fi
else
  echo "[7] 真实模型对话：已跳过（--no-model）"
fi

echo "--------------------------------------------------------------"
echo " 自检结果: $PASS passed, $FAIL failed"
echo "--------------------------------------------------------------"
[[ "$FAIL" -eq 0 ]]
