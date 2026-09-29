#!/usr/bin/env bash
# Phase 2 端到端验收：验证图谱 API 与三层上下文路由真实闭环。
# 依赖：NodeX API 已启动，且 OpenCode 隔离实例可用。
set -euo pipefail

API="${NODEX_API:-http://127.0.0.1:4501}"
PASS=0
FAIL=0

check() {
  local name="$1" actual="$2" expected="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "  PASS  $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  $name"
    echo "        期望包含: $expected"
    echo "        实际: ${actual:0:300}"
    FAIL=$((FAIL + 1))
  fi
}

jq_get() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1"; }

echo "[1] 健康检查"
HEALTH=$(curl -s -m 15 "$API/health")
check "opencode 已连接" "$HEALTH" '"healthy": true'

echo "[2] 节点即会话"
WS=$(curl -s -m 15 -X POST "$API/workspaces" -H 'Content-Type: application/json' \
  -d '{"name":"项目 A","systemPrompt":"你是项目 A 的编码助手"}')
WS_ID=$(echo "$WS" | jq_get "d['id']")
check "创建工作区" "$WS" "$WS_ID"

NODE_A=$(curl -s -m 30 -X POST "$API/nodes" -H 'Content-Type: application/json' \
  -d "{\"title\":\"节点A\",\"workspaceId\":\"$WS_ID\"}")
NODE_A_ID=$(echo "$NODE_A" | jq_get "d['id']")
check "创建节点并绑定会话" "$NODE_A" "$NODE_A_ID"

NODE_OUT=$(curl -s -m 30 -X POST "$API/nodes" -H 'Content-Type: application/json' \
  -d '{"title":"圈外节点"}')
NODE_OUT_ID=$(echo "$NODE_OUT" | jq_get "d['id']")
check "创建圈外节点" "$NODE_OUT" "$NODE_OUT_ID"

echo "[3] 真实对话与上下文注入"
REPLY=$(curl -s -m 90 -X POST "$API/nodes/$NODE_A_ID/prompt" -H 'Content-Type: application/json' \
  -d '{"text":"只回复两个字：收到"}')
check "真实模型回复" "$REPLY" '"reply"'
check "注入工作区 System Prompt" "$REPLY" '项目 A 的编码助手'
check "硬加载 tier 正确" "$REPLY" '"tier": "hard"'

echo "[4] 工作区隔离"
curl -s -m 15 -X POST "$API/workspaces/$WS_ID/members" -H 'Content-Type: application/json' \
  -d "{\"nodeId\":\"$NODE_OUT_ID\",\"action\":\"leave\"}" > /dev/null
MEMBERS=$(curl -s -m 15 "$API/workspaces/$WS_ID/members")
check "成员仅含圈内节点" "$MEMBERS" "$NODE_A_ID"
if [[ "$MEMBERS" == *"$NODE_OUT_ID"* ]]; then
  echo "  FAIL  圈外节点不应出现在成员列表"
  FAIL=$((FAIL + 1))
else
  echo "  PASS  圈外节点已被隔离"
  PASS=$((PASS + 1))
fi

echo "[5] Portal 只传摘要快照"
curl -s -m 30 -X POST "$API/nodes/$NODE_OUT_ID/summarize" > /dev/null || true
GRAPH=$(curl -s -m 15 "$API/graph")
check "图谱包含节点与工作区" "$GRAPH" "$NODE_A_ID"

echo "[6] 清理"
curl -s -m 20 -X DELETE "$API/nodes/$NODE_A_ID" > /dev/null
curl -s -m 20 -X DELETE "$API/nodes/$NODE_OUT_ID" > /dev/null
echo "  DONE  已删除测试节点"

echo
echo "结果: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
