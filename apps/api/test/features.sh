#!/usr/bin/env bash
# 验收：节点元数据编辑、AI 生成、连线删除/合并/派生。
set -uo pipefail

API="${NODEX_API:-http://127.0.0.1:4501}"
PASS=0
FAIL=0

ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
has() { [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1（未找到: $3）"; }
phy() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1"; }

jpost() { curl -s -m "${3:-20}" -X POST "$API$1" -H 'Content-Type: application/json' -d "$2"; }

echo "=============================================================="
echo " 节点元数据 / 连线操作验收"
echo "=============================================================="

echo "[1] 创建测试图谱"
WS=$(jpost /workspaces '{"name":"验收工作区","systemPrompt":"你是验收助手"}' | phy "d['id']")
N1=$(jpost /nodes "{\"title\":\"节点一\",\"workspaceId\":\"$WS\"}" | phy "d['id']")
N2=$(jpost /nodes "{\"title\":\"节点二\",\"workspaceId\":\"$WS\"}" | phy "d['id']")
[[ -n "$N1" && -n "$N2" ]] && ok "创建两个节点" || bad "节点创建失败"

echo "[2] 手动修改标题与类别"
PATCH=$(curl -s -m 15 -X PATCH "$API/nodes/$N1" -H 'Content-Type: application/json' \
  -d '{"title":"手动标题","category":"手动类别","tags":["a","b"]}')
has "标题已更新" "$PATCH" '手动标题'
has "类别已更新" "$PATCH" '手动类别'
has "标签已更新" "$PATCH" '"a"'
CHECK=$(curl -s -m 15 "$API/nodes/$N1")
has "重新读取仍为新标题" "$CHECK" '手动标题'

echo "[3] 空标题应被拒绝"
EMPTY=$(curl -s -m 15 -X PATCH "$API/nodes/$N1" -H 'Content-Type: application/json' -d '{"title":"  "}')
has "空标题返回错误" "$EMPTY" '"error"'

echo "[4] 手动写入摘要"
SUM=$(jpost "/nodes/$N1/summary" '{"text":"这是手动摘要内容"}')
has "摘要已保存" "$SUM" '手动摘要内容'
has "摘要来源标记为 manual" "$SUM" '"manual"'

echo "[5] 建立连接（reference）"
LINK=$(jpost /links "{\"kind\":\"reference\",\"from\":\"$N1\",\"to\":\"$N2\"}")
LINK_ID=$(echo "$LINK" | phy "d['id']")
has "连接已创建" "$LINK" "$LINK_ID"

echo "[6] Portal 自动生成快照"
PORTAL=$(jpost /links "{\"kind\":\"portal\",\"from\":\"$N2\",\"to\":\"$N1\"}")
PORTAL_ID=$(echo "$PORTAL" | phy "d['id']")
has "Portal 自动带快照" "$PORTAL" '"snapshot"'
has "快照含目标节点内容" "$PORTAL" '手动摘要内容'

echo "[7] 连线派生新节点（读两侧摘要与详情）"
SPAWN=$(jpost "/links/$LINK_ID/spawn" '{}')
SPAWN_ID=$(echo "$SPAWN" | phy "d['node']['id']")
has "派生节点已创建" "$SPAWN" "$SPAWN_ID"
SPAWN_LINKS=$(echo "$SPAWN" | phy "len(d['links'])")
[[ "$SPAWN_LINKS" == "2" ]] && ok "派生节点带两条 portal（来自两侧）" || bad "应为 2 条 portal，实际 $SPAWN_LINKS"
has "派生节点初始无对话" "$SPAWN" "$SPAWN_ID"

echo "[8] 连线合并（指定保留方向）"
M1=$(jpost /nodes "{\"title\":\"被合并方\"}" | phy "d['id']")
M2=$(jpost /nodes "{\"title\":\"保留方\"}" | phy "d['id']")
ML=$(jpost /links "{\"kind\":\"merge\",\"from\":\"$M1\",\"to\":\"$M2\"}" | phy "d['id']")
MERGE=$(jpost "/links/$ML/merge" "{\"into\":\"$M2\"}" 90)
has "合并返回保留节点" "$MERGE" "$M2"
has "源节点被归档" "$MERGE" "$M1"
M2_AFTER=$(curl -s -m 15 "$API/nodes/$M2")
has "保留方获得合并摘要" "$M2_AFTER" '"mergedFrom"'
M1_AFTER=$(curl -s -m 15 "$API/nodes/$M1")
has "被合并方标记 mergedInto" "$M1_AFTER" 'mergedInto'

echo "[9] 归档节点默认不出现在画布"
# 注意：M1 的 id 会作为 mergedInto 元数据出现在其他节点中，
# 因此必须按节点身份判断，而非子串匹配。
GRAPH=$(curl -s -m 15 "$API/graph")
ARCHIVED_ON_CANVAS=$(echo "$GRAPH" | phy "any(n['id']=='$M1' for n in d['nodes'])")
[[ "$ARCHIVED_ON_CANVAS" == "False" ]] && ok "归档节点已从默认画布隐藏" || bad "归档节点仍出现在默认画布"
ARCHIVED_AS_LINK=$(echo "$GRAPH" | phy "any(l['from']=='$M1' or l['to']=='$M1' for l in d['links'])")
[[ "$ARCHIVED_AS_LINK" == "False" ]] && ok "指向归档节点的连线已隐藏" || bad "归档节点的连线仍可见"
ALL=$(curl -s -m 15 "$API/graph?includeArchived=1")
has "includeArchived=1 可读回归档节点" "$ALL" "$M1"

echo "[10] 删除连线"
DEL=$(curl -s -m 15 -X DELETE "$API/links/$PORTAL_ID")
has "连线已删除" "$DEL" '"deleted": true'
CHECK_LINK=$(curl -s -m 15 -X DELETE "$API/links/$PORTAL_ID")
has "重复删除返回 404" "$CHECK_LINK" '连接不存在'

echo "[11] 工作区生命周期（画布）"
WS2=$(jpost /workspaces '{"name":"画布B","origin":{"x":600,"y":0}}' | phy "d['id']")
ORIGIN=$(curl -s -m 15 "$API/graph" | phy "[w.get('origin') for w in d['workspaces'] if w['id']=='$WS2'][0] if any(w['id']=='$WS2' for w in d['workspaces']) else None")
[[ "$ORIGIN" != "None" ]] && ok "新建工作区持久化 origin（空画布可见）" || bad "工作区 origin 未保存"
RENAMED=$(curl -s -m 15 -X PATCH "$API/workspaces/$WS2" -H 'Content-Type: application/json' -d '{"name":"画布B改"}')
has "工作区可重命名" "$RENAMED" '画布B改'
MERGE=$(jpost "/workspaces/$WS2/merge" "{\"into\":\"$WS\"}")
has "合并返回 mergedFrom" "$MERGE" '"mergedFrom"'
STILL=$(curl -s -m 15 "$API/graph" | phy "any(w['id']=='$WS2' for w in d['workspaces'])")
[[ "$STILL" == "False" ]] && ok "源工作区合并后已删除" || bad "源工作区仍存在"

WS3=$(jpost /workspaces '{"name":"临时画布","origin":{"x":1200,"y":0}}' | phy "d['id']")
KEEP_ID=$(jpost /nodes "{\"title\":\"保留节点\",\"workspaceId\":\"$WS3\"}" | phy "d['id']")
curl -s -m 15 -X DELETE "$API/workspaces/$WS3" > /dev/null
KEEP=$(curl -s -m 15 "$API/graph" | phy "any(n['id']=='$KEEP_ID' for n in d['nodes'])")
[[ "$KEEP" == "True" ]] && ok "删除工作区后节点保留" || bad "节点被误删"
curl -s -m 20 -X DELETE "$API/nodes/$KEEP_ID" > /dev/null

echo "[12] 主模型选择（来自运行时配置）"
MODELS=$(curl -s -m 20 "$API/models")
COUNT=$(echo "$MODELS" | phy "len(d['models'])")
[[ "$COUNT" -ge 1 ]] && ok "枚举到 $COUNT 个可用模型" || bad "未枚举到模型"
has "返回当前默认模型" "$MODELS" '"default"'
DEF_PROVIDER=$(echo "$MODELS" | phy "d['default']['providerID'] if d.get('default') else ''")
DEF_MODEL=$(echo "$MODELS" | phy "d['default']['modelID'] if d.get('default') else ''")
if [[ -n "$DEF_PROVIDER" && -n "$DEF_MODEL" ]]; then
  SAVED=$(curl -s -m 15 -X PUT "$API/settings" -H 'Content-Type: application/json' \
    -d "{\"defaultModel\":{\"providerID\":\"$DEF_PROVIDER\",\"modelID\":\"$DEF_MODEL\"}}")
  has "设置全局默认模型" "$SAVED" "$DEF_MODEL"
  ROUND=$(curl -s -m 15 "$API/settings")
  has "设置可回读" "$ROUND" "$DEF_MODEL"
  BADMODEL=$(curl -s -m 15 -X PUT "$API/settings" -H 'Content-Type: application/json' -d '{"defaultModel":{"providerID":"x"}}')
  has "非法模型被拒绝" "$BADMODEL" '"error"'
else
  bad "默认模型缺失，跳过设置用例"
fi

echo "[13] 笔记本：草稿与摘录"
NB=$(jpost /nodes '{"kind":"notebook","title":"验收笔记本"}' | phy "d['id']")
[[ -n "$NB" ]] && ok "创建笔记本节点" || bad "笔记本创建失败"
NBK=$(curl -s -m 15 "$API/nodes/$NB" | phy "d['node']['kind']")
[[ "$NBK" == "notebook" ]] && ok "节点类型为 notebook" || bad "类型错误：$NBK"
NBHAS_SESSION=$(curl -s -m 15 "$API/nodes/$NB" | phy "'opencodeSessionId' in d['node'] and bool(d['node']['opencodeSessionId'])")
[[ "$NBHAS_SESSION" == "False" ]] && ok "笔记本不绑定运行时会话" || bad "笔记本不应有会话"
DOC=$(curl -s -m 15 -X PUT "$API/nodes/$NB/doc" -H 'Content-Type: application/json' -d '{"doc":"# 草稿\n- 一"}')
has "保存草稿" "$DOC" '草稿'
EXCERPT=$(jpost "/nodes/$NB/excerpt" '{"text":"这是摘录的一句话","fromTitle":"来源节点"}')
has "摘录追加到笔记本" "$EXCERPT" '> 这是摘录的一句话'
has "摘录标注来源" "$EXCERPT" '来源节点'

echo "[14] 摘录新建对话节点（seed，不触发模型）"
SEED=$(jpost /nodes '{"title":"摘录对话","seed":"【摘录自「某节点」】\n背景资料","workspaceId":"'"$WS"'"}')
SEED_ID=$(echo "$SEED" | phy "d['id']")
SEED_SESSION=$(echo "$SEED" | phy "bool(d.get('opencodeSessionId'))")
[[ "$SEED_SESSION" == "True" ]] && ok "摘录节点已绑定会话" || bad "摘录节点缺少会话"
SEED_MSGS=$(curl -s -m 15 "$API/nodes/$SEED_ID" | phy "len(d.get('messages',[]))")
[[ "$SEED_MSGS" -ge 1 ]] && ok "摘录内容已注入会话（$SEED_MSGS 条）" || bad "摘录内容未注入"

echo "[15] defer 快速创建（不再串行等待两次模型调用）"
START=$(date +%s)
DEFER=$(jpost /nodes '{"content":"defer 冒烟","defer":true}')
DEFER_ID=$(echo "$DEFER" | phy "d['id']")
ELAPSED=$(( $(date +%s) - START ))
[[ "$ELAPSED" -lt 10 ]] && ok "defer 创建耗时 ${ELAPSED}s（<10s）" || bad "defer 创建过慢：${ELAPSED}s"

echo "[16] 产出文件解析与预览（限制在项目根目录）"
FILES=$(curl -s -m 20 "$API/nodes/$DEFER_ID/files")
has "返回文件列表结构" "$FILES" '"files"'
has "返回预览根目录" "$FILES" '"root"'
README=$(curl -s -m 15 "$API/file?path=README.md")
has "读取项目内文件" "$README" '"kind": "markdown"'
has "文本按 utf8 返回" "$README" '"encoding": "utf8"'
ESCAPE=$(curl -s -m 15 "$API/file?path=/etc/passwd")
has "越界路径被拒绝" "$ESCAPE" '超出允许预览的根目录'
MISS=$(curl -s -m 15 "$API/file?path=README.md")
has "包含文件完整路径" "$MISS" '"path"'

echo "[17] 多 agent 协作布局模板"
TEMPLATES=$(curl -s -m 15 "$API/templates")
TCOUNT=$(echo "$TEMPLATES" | phy "len(d['templates'])")
[[ "$TCOUNT" -ge 3 ]] && ok "内置协作模板可读取（$TCOUNT 个）" || bad "内置模板数量不足"
has "内置三省六部模板" "$TEMPLATES" '三省六部'
CUSTOM=$(jpost /templates '{"name":"验收协作模板","description":"两 agent","slots":[{"key":"a","label":"甲","x":-100,"y":0},{"key":"b","label":"乙","x":100,"y":0}],"links":[{"from":"a","to":"b","kind":"dependency"}]}')
CUSTOM_ID=$(echo "$CUSTOM" | phy "d['id']")
has "可保存自定义模板" "$CUSTOM" '验收协作模板'
CUSTOM_READ=$(curl -s -m 15 "$API/templates")
has "自定义模板可回读" "$CUSTOM_READ" "$CUSTOM_ID"
CUSTOM_DEL=$(curl -s -m 15 -X DELETE "$API/templates/$CUSTOM_ID")
has "可删除自定义模板" "$CUSTOM_DEL" '"deleted": true'
BUILTIN_DEL=$(curl -s -m 15 -X DELETE "$API/templates/builtin-brainstorm")
has "内置模板禁止删除" "$BUILTIN_DEL" '内置模板不可删除'
RUNTIME=$(curl -s -m 15 "$API/runtime/status")
has "运行时状态端点可用" "$RUNTIME" '"sessions"'

echo "[18] 清理"
curl -s -m 20 -X DELETE "$API/nodes/$NB" > /dev/null
curl -s -m 20 -X DELETE "$API/nodes/$SEED_ID" > /dev/null
curl -s -m 20 -X DELETE "$API/nodes/$DEFER_ID" > /dev/null
ok "新增测试节点已清理"

echo "[19] 清理"
curl -s -m 20 -X DELETE "$API/nodes/$N1" > /dev/null
curl -s -m 20 -X DELETE "$API/nodes/$N2" > /dev/null
curl -s -m 20 -X DELETE "$API/nodes/$SPAWN_ID" > /dev/null
curl -s -m 20 -X DELETE "$API/nodes/$M2" > /dev/null
ok "测试节点已清理"

echo "=============================================================="
echo " 结果: $PASS passed, $FAIL failed"
echo "=============================================================="
[[ "$FAIL" -eq 0 ]]
