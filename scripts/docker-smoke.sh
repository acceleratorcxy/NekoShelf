#!/usr/bin/env bash
# NekoShelf Docker 冒烟：容器内跑通 健康检查 / 初始化 / 建库 / 扫描 / 列表 / 封面 / 页图 /
# RAR 包直读 / 进度 / SPA / 查询语法 / 两级缩略图 / 流式不落盘，并校验源目录只读。
#
# 用法：bash scripts/docker-smoke.sh [镜像名]
#   PORT    覆盖端口（默认 18080）
#   样本：前 2 个作品目录（各 4 张图）+ 一个多页压缩包（需设置 NEKO_EH_SRC / NEKO_RAR_SAMPLE）
# 注意：需在 WSL 内以 root 运行（/config、/cache 需可写；`wsl -d Ubuntu -u root -- bash ...`）。
set -u

IMAGE="${1:-nekoshelf:m1}"
PORT="${PORT:-18080}"
BASE="http://127.0.0.1:${PORT}"
NAME=neko-smoke
MEDIA=/tmp/neko-smoke-media
MEDIA2=/tmp/neko-smoke-media2
CFG=/tmp/neko-smoke-config
CACHE=/tmp/neko-smoke-cache
COOKIE=/tmp/neko-smoke-cookie.txt
LOG=/tmp/neko-smoke.log
EH_SRC="${NEKO_EH_SRC:?需要设置 NEKO_EH_SRC（样本目录）}"
RAR_SAMPLE="${NEKO_RAR_SAMPLE:-${NEKO_RAR_SAMPLE:?需要设置 NEKO_RAR_SAMPLE}}"

PASS_N=0
FAIL_N=0
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
pass() { PASS_N=$((PASS_N + 1)); log "PASS $*"; }
fail() { FAIL_N=$((FAIL_N + 1)); log "FAIL: $*"; }
check() { if [ "$2" = 1 ]; then pass "$1"; else fail "$1"; fi }
finish() {
  docker rm -f "$NAME" >/dev/null 2>&1
  if [ "$FAIL_N" -gt 0 ]; then log "=== $FAIL_N 项失败 / $PASS_N 项通过 ==="; exit 1; fi
  log "=== ALL PASS（$PASS_N 项）==="
}
http_code() { curl -s -o "$1" -w '%{http_code}' "${@:2}"; }

rm -rf "$MEDIA" "$MEDIA2" "$CFG" "$CACHE" "$LOG" "$COOKIE"
mkdir -p "$MEDIA" "$MEDIA2" "$CFG" "$CACHE"
docker rm -f "$NAME" >/dev/null 2>&1 || true

# ---------- 样本 ----------
count=0
for dir in "$EH_SRC"/*/; do
  imgs=$(find "$dir" -maxdepth 1 -type f \( -name '*.webp' -o -name '*.jpg' -o -name '*.png' \) | wc -l)
  if [ "$imgs" -ge 4 ]; then
    name=$(basename "$dir")
    mkdir -p "$MEDIA/$name"
    find "$dir" -maxdepth 1 -type f \( -name '*.webp' -o -name '*.jpg' -o -name '*.png' \) |
      sort | head -4 | while IFS= read -r f; do cp "$f" "$MEDIA/$name/"; done
    count=$((count + 1))
    [ "$count" -ge 2 ] && break
  fi
done
[ "$count" -ge 2 ] || { log "FAIL: 真实样本目录不足（$EH_SRC）"; exit 1; }
log "样本：$(ls "$MEDIA" | tr '\n' ' ')"
if [ -f "$RAR_SAMPLE" ]; then
  cp "$RAR_SAMPLE" "$MEDIA2/1.rar"
else
  log "WARN: 缺 RAR 样本（$RAR_SAMPLE），跳过压缩包段"
fi
snapshot() { find "$1" -type f -printf '%s %T@ %p\n' | sort; }
BEFORE=$(snapshot "$MEDIA")
BEFORE2=$(snapshot "$MEDIA2")

# ---------- 容器 ----------
docker run -d --name "$NAME" -p "$PORT:8080" \
  -v "$MEDIA:/data:ro" -v "$MEDIA2:/data-m2:ro" -v "$CFG:/config" -v "$CACHE:/cache" \
  -u 0:0 "$IMAGE" >/dev/null

ready=0
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz" || true)
  if [ "$code" = 200 ]; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { docker logs "$NAME" | tail -20; log "FAIL: 容器 60s 内未就绪"; exit 1; }
check "healthz" "$(curl -s "$BASE/healthz" | grep -c '"ok"')"

curl -s -c "$COOKIE" -H 'content-type: application/json' \
  -d '{"username":"smoke","password":"smoke-password"}' "$BASE/api/setup" >/dev/null
check "首次初始化 + 会话 Cookie" "$(grep -c 'sid' "$COOKIE")"
check "登录态 /api/auth/me" "$(curl -s -b "$COOKIE" "$BASE/api/auth/me" | grep -c '"username":"smoke"')"

wait_scan() { # $1=libId → 打印 state
  job=$(curl -s -b "$COOKIE" -H 'content-type: application/json' -d '{}' "$BASE/api/libraries/$1/scan" | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')
  [ -n "$job" ] || { echo ""; return; }
  for i in $(seq 1 300); do
    st=$(curl -s -b "$COOKIE" "$BASE/api/jobs/$job" | sed -n 's/.*"state":"\([^"]*\)".*/\1/p')
    case "$st" in done | failed) break ;; esac
    sleep 1
  done
  echo "$st"
}

# ---------- 图片库 ----------
curl -s -b "$COOKIE" -H 'content-type: application/json' \
  -d '{"name":"图片库","rootPath":"/data","kind":"comic"}' "$BASE/api/libraries" >/dev/null
state=$(wait_scan 1)
check "扫描完成（state=$state）" "$([ "$state" = done ] && echo 1 || echo 0)"
works=$(curl -s -b "$COOKIE" "$BASE/api/works?pageSize=50")
n=$(echo "$works" | grep -o '"id":' | wc -l)
check "作品数 ≥ 2（$n）" "$([ "$n" -ge 2 ] && echo 1 || echo 0)"
wid=$(echo "$works" | sed -n 's/.*"items":\[{"id":\([0-9]*\).*/\1/p')
OUT_COVER=$(mktemp -t neko-cover.XXXXXX)
code=$(http_code "$OUT_COVER" -b "$COOKIE" "$BASE/api/works/$wid/cover")
size=$(stat -c%s "$OUT_COVER" 2>/dev/null || echo 0)
check "封面 200 webp（$code / ${size}B）" "$([ "$code" = 200 ] && [ "$size" -gt 100 ] && echo 1 || echo 0)"
OUT_PAGE=$(mktemp -t neko-page.XXXXXX)
code=$(http_code "$OUT_PAGE" -b "$COOKIE" "$BASE/api/works/$wid/pages/1/image")
size=$(stat -c%s "$OUT_PAGE" 2>/dev/null || echo 0)
check "页图 200（$code / ${size}B）" "$([ "$code" = 200 ] && [ "$size" -gt 1000 ] && echo 1 || echo 0)"
check "SPA 入口页 200" "$(curl -s -b "$COOKIE" "$BASE/" | grep -c 'id="root"')"
AFTER=$(snapshot "$MEDIA")
check "源文件只读" "$([ "$BEFORE" = "$AFTER" ] && echo 1 || echo 0)"

# ---------- RAR 包直读 ----------
if [ -f "$MEDIA2/1.rar" ]; then
  curl -s -b "$COOKIE" -H 'content-type: application/json' \
    -d '{"name":"压缩包","rootPath":"/data-m2","kind":"comic"}' "$BASE/api/libraries" >/dev/null
  lib2=$(curl -s -b "$COOKIE" "$BASE/api/libraries" | grep -o '"id":[0-9]*' | tail -1 | cut -d: -f2)
  state=$(wait_scan "$lib2")
  check "RAR 扫描完成（state=$state）" "$([ "$state" = done ] && echo 1 || echo 0)"
  works2=$(curl -s -b "$COOKIE" "$BASE/api/works?libraryId=$lib2&pageSize=10")
  pages2=$(echo "$works2" | sed -n 's/.*"pageCount":\([0-9]*\).*/\1/p' | head -1)
  check "RAR 入库且页数 218（$pages2）" "$([ "$pages2" = 218 ] && echo 1 || echo 0)"
  wid2=$(echo "$works2" | sed -n 's/.*"items":\[{"id":\([0-9]*\).*/\1/p')
  OUT_RCOVER=$(mktemp -t neko-rar-cover.XXXXXX)
  code=$(http_code "$OUT_RCOVER" -b "$COOKIE" "$BASE/api/works/$wid2/cover")
  size=$(stat -c%s "$OUT_RCOVER" 2>/dev/null || echo 0)
  check "RAR 封面 200 webp（$code / ${size}B）" "$([ "$code" = 200 ] && [ "$size" -gt 100 ] && echo 1 || echo 0)"
  OUT_RPAGE=$(mktemp -t neko-rar-page.XXXXXX)
  code=$(http_code "$OUT_RPAGE" -b "$COOKIE" "$BASE/api/works/$wid2/pages/1/image")
  size=$(stat -c%s "$OUT_RPAGE" 2>/dev/null || echo 0)
  magic=$(head -c 2 "$OUT_RPAGE" | od -An -tx1 | tr -d ' \n')
  check "RAR 页图 200 且为 JPEG（$code / ${size}B / $magic）" \
    "$([ "$code" = 200 ] && [ "$size" -gt 1000 ] && [ "$magic" = ffd8 ] && echo 1 || echo 0)"
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" -H 'content-type: application/json' \
    -X PUT -d '{"page":3}' "$BASE/api/works/$wid2/progress")
  check "进度保存（$code）" "$([ "$code" = 204 ] && echo 1 || echo 0)"
  AFTER2=$(snapshot "$MEDIA2")
  check "源文件只读" "$([ "$BEFORE2" = "$AFTER2" ] && echo 1 || echo 0)"
fi

# ---------- 查询语法 / 两级缩略图 / 流式不落盘 / 刮削冷却字段 ----------
qn=$(curl -s -b "$COOKIE" "$BASE/api/works?q=pages:%3E%3D4&pageSize=50" | grep -o '"id":' | wc -l)
check "查询 pages:>=4 命中 3（$qn）" "$([ "$qn" = 3 ] && echo 1 || echo 0)"
qn0=$(curl -s -b "$COOKIE" "$BASE/api/works?q=pages:%3E99999&pageSize=10" | grep -o '"id":' | wc -l)
check "查询 pages:>99999 命中 0（$qn0）" "$([ "$qn0" = 0 ] && echo 1 || echo 0)"
OUT_THUMB=$(mktemp -t neko-thumb.XXXXXX)
code=$(http_code "$OUT_THUMB" -b "$COOKIE" "$BASE/api/works/$wid/pages/1/thumb?w=160")
size=$(stat -c%s "$OUT_THUMB" 2>/dev/null || echo 0)
check "两级缩略图 w=160（$code / ${size}B）" "$([ "$code" = 200 ] && [ "$size" -gt 100 ] && echo 1 || echo 0)"
if [ -f "$MEDIA2/1.rar" ]; then
  left=$(find "$CACHE/archives" -type f -name '*.jpg' 2>/dev/null | wc -l)
  check "归档图片页不落盘（残留 $left）" "$([ "$left" = 0 ] && echo 1 || echo 0)"
fi
cool=$(curl -s -b "$COOKIE" "$BASE/api/scraper" | grep -c '"cooldownMs"')
check "刮削状态含 cooldownMs" "$([ "$cool" = 1 ] && echo 1 || echo 0)"

# ---------- AI 搜索默认关闭 / 标签接口 / 任务列表 ----------
ai=$(curl -s -b "$COOKIE" "$BASE/api/ai")
check "AI 状态可读且默认关闭" "$(echo "$ai" | grep -c '"enabled":false')"
OUT_AI=$(mktemp -t neko-ai.XXXXXX)
aicode=$(http_code "$OUT_AI" -b "$COOKIE" -H 'content-type: application/json' -d '{"q":"找几页评分高的"}' "$BASE/api/ai/query")
check "AI 关闭时自然语言搜索返回 409（$aicode）" "$([ "$aicode" = 409 ] && grep -cq 'ai_disabled' "$OUT_AI" && echo 1 || echo 0)"
tags=$(curl -s -b "$COOKIE" "$BASE/api/tags")
check "标签接口 200 且含 items" "$(echo "$tags" | grep -c '"items"')"
jobs=$(curl -s -b "$COOKIE" "$BASE/api/jobs")
check "任务列表 200 且含扫描记录" "$(echo "$jobs" | grep -c '"items"')"

org=$(curl -s -b "$COOKIE" "$BASE/api/organize")
check "整理状态可读且只读（writebackEnabled=false）" "$(echo "$org" | grep -c '"writebackEnabled":false')"
OUT_ORG=$(mktemp -t neko-org.XXXXXX)
orgcode=$(http_code "$OUT_ORG" -b "$COOKIE" "$BASE/api/organize/preview?libraryId=1&limit=5")
check "整理预览 200（$orgcode）" "$([ "$orgcode" = 200 ] && grep -cq '"items"' "$OUT_ORG" && echo 1 || echo 0)"
OUT_NFO=$(mktemp -t neko-nfo.XXXXXX)
nfocode=$(http_code "$OUT_NFO" -b "$COOKIE" "$BASE/api/works/$wid/nfo")
check "NFO 预览 200 且为 movie（$nfocode）" "$([ "$nfocode" = 200 ] && grep -cq '<movie>' "$OUT_NFO" && echo 1 || echo 0)"
dups=$(curl -s -b "$COOKIE" "$BASE/api/duplicates")
check "重复接口 200" "$(echo "$dups" | grep -c '"groups"')"
OUT_APPLY=$(mktemp -t neko-apply.XXXXXX)
applycode=$(http_code "$OUT_APPLY" -b "$COOKIE" -H 'content-type: application/json' -d '{"libraryId":1,"confirm":true}' "$BASE/api/organize/apply")
check "只读部署下整理执行被拒 409（$applycode）" "$([ "$applycode" = 409 ] && echo 1 || echo 0)"

# ---------- journal / NFO 写回门禁 / 合并门禁 ----------
journal=$(curl -s -b "$COOKIE" "$BASE/api/organize/journal")
check "journal 列表 200 且含 entries" "$(echo "$journal" | grep -c '"entries"')"
OUT_NFOW=$(mktemp -t neko-nfow.XXXXXX)
nfowcode=$(http_code "$OUT_NFOW" -b "$COOKIE" -H 'content-type: application/json' -d '{"confirm":true}' "$BASE/api/works/$wid/nfo")
check "只读部署下 NFO 写回被拒 409（$nfowcode）" "$([ "$nfowcode" = 409 ] && grep -cq 'writeback_disabled' "$OUT_NFOW" && echo 1 || echo 0)"
OUT_MERGE=$(mktemp -t neko-merge.XXXXXX)
mergecode=$(http_code "$OUT_MERGE" -b "$COOKIE" -H 'content-type: application/json' -d '{"keepId":1}' "$BASE/api/works/merge")
check "合并缺 confirm 返回 400（$mergecode）" "$([ "$mergecode" = 400 ] && echo 1 || echo 0)"
OUT_UNDO=$(mktemp -t neko-undo.XXXXXX)
undocode=$(http_code "$OUT_UNDO" -b "$COOKIE" -X POST "$BASE/api/organize/undo/nfo-123")
check "撤销未知 journal 404（$undocode）" "$([ "$undocode" = 404 ] && echo 1 || echo 0)"

# ---------- 维护与在线备份 ----------
maint=$(curl -s -b "$COOKIE" "$BASE/api/maintenance")
check "维护信息 200 且含版本" "$(echo "$maint" | grep -c '"version"')"
OUT_BK=$(mktemp -t neko-bk.XXXXXX)
bkcode=$(http_code "$OUT_BK" -b "$COOKIE" -X POST "$BASE/api/maintenance/backup")
check "在线备份 200（$bkcode）" "$([ "$bkcode" = 200 ] && grep -cq '"backup"' "$OUT_BK" && echo 1 || echo 0)"
maint2=$(curl -s -b "$COOKIE" "$BASE/api/maintenance")
cb=$(echo "$maint2" | sed -n 's/.*"backupCount":\([0-9]*\).*/\1/p')
check "备份后 backupCount≥1（$cb）" "$([ "${cb:-0}" -ge 1 ] && echo 1 || echo 0)"

finish
