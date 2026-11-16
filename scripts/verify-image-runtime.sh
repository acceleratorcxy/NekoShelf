#!/usr/bin/env bash
# 验证镜像：非 root（node/1000）运行、healthcheck 转健康、/config 可写（setup 落库）。
# 用法：bash scripts/verify-image-runtime.sh [镜像名]；跑完容器保留，手动 docker rm -f nk-runtime 清理。
set -euo pipefail
IMAGE="${1:-nekoshelf:m1}"
# 注意：不要放 /tmp —— WSL 重启会清空 /tmp，绑定挂载目录被 docker 以 root 重建后容器会以 node 身份写失败。
ROOT="${ROOT:-$HOME/neko-runtime}"
PORT="${PORT:-18081}"

rm -rf "$ROOT"
mkdir -p "$ROOT/media" "$ROOT/config" "$ROOT/cache"
chown -R 1000:1000 "$ROOT/config" "$ROOT/cache"
cp -r /tmp/neko-smoke-media/. "$ROOT/media/" 2>/dev/null || true
docker rm -f nk-runtime >/dev/null 2>&1 || true

docker run -d --name nk-runtime -p "${PORT}:8080" \
  -v "$ROOT/media:/data:ro" -v "$ROOT/config:/config" -v "$ROOT/cache:/cache" "$IMAGE" >/dev/null

ready=0
for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { docker logs nk-runtime | tail -20; exit 1; }
echo -n "healthz: "; curl -s "http://127.0.0.1:${PORT}/healthz"; echo
echo -n "进程身份: "; docker exec nk-runtime id

status=""
for i in $(seq 1 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' nk-runtime)
  [ "$status" = healthy ] && break
  sleep 2
done
echo "healthcheck: $status"

curl -sf -c /tmp/nk-cookie -H 'content-type: application/json' \
  -d '{"username":"admin","password":"testpass123"}' "http://127.0.0.1:${PORT}/api/setup" >/dev/null
echo "setup -> /config 写入:"
ls -l "$ROOT/config"
