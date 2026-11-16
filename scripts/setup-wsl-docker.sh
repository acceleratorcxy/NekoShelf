#!/usr/bin/env bash
# NekoShelf 开发环境 —— WSL2 (Ubuntu 24.04) 内一键装齐 Docker 全套。幂等，可重复执行。
#
# 覆盖内容：
#   1. apt 装 docker.io + compose v2 + buildx + qemu-user-static + 解压/DB 工具
#   2. 给 dockerd 配 HTTP(S) 代理（WSL mirrored 网络下直接复用 Windows 上的 Clash）
#   3. 注册 qemu binfmt（WSL 下 systemd-binfmt 被 ConditionVirtualization=!wsl 跳过，需自建 unit）
#   4. 创建 buildx 多架构 builder（docker-container + buildkitd.toml 镜像源 + 代理）
#
# 用法（在 WSL 的 Ubuntu 里，仓库任意位置）：
#   bash scripts/setup-wsl-docker.sh                 # 默认代理 http://127.0.0.1:7890
#   bash scripts/setup-wsl-docker.sh http://127.0.0.1:7897
#
# 前置：Windows 侧 %UserProfile%\.wslconfig 需要（只写这几项，多加反而断网，见 docs/开发环境搭建.md）：
#   [wsl2]
#   memory=16GB
#   processors=12
#   swap=8GB
#   networkingMode=mirrored
set -euo pipefail

PROXY="${1:-http://127.0.0.1:7890}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_USER="${SUDO_USER:-$USER}"

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
need_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

say "0/6 检查 systemd（WSL 需 systemd=true）"
if [ "$(tr -d '\0' </proc/1/comm)" != "systemd" ]; then
    echo "错误：PID 1 不是 systemd。请在 Windows 侧 %UserProfile%\\.wslconfig 的 [boot] 段加 systemd=true，然后 wsl --shutdown 重进。" >&2
    exit 1
fi

say "1/6 安装基础包"
need_root apt-get update -qq
need_root apt-get install -y -qq \
    docker.io docker-compose-v2 docker-buildx \
    qemu-user-static binfmt-support \
    p7zip-full unrar-free sqlite3 libarchive-tools \
    curl ca-certificates git jq

say "2/6 配置 dockerd 代理（$PROXY）"
need_root mkdir -p /etc/systemd/system/docker.service.d
need_root tee /etc/systemd/system/docker.service.d/http-proxy.conf >/dev/null <<EOF
[Service]
Environment="HTTP_PROXY=$PROXY"
Environment="HTTPS_PROXY=$PROXY"
Environment="NO_PROXY=localhost,127.0.0.1,::1"
EOF

say "3/6 docker.io 镜像源（代理不可用时的兜底；已存在则跳过）"
if [ ! -f /etc/docker/daemon.json ]; then
    need_root tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "registry-mirrors": ["https://docker.m.daocloud.io", "https://docker.1ms.run"]
}
EOF
fi

say "4/6 启动 docker 并把 $TARGET_USER 加入 docker 组"
need_root systemctl daemon-reload
need_root systemctl enable --now docker
need_root usermod -aG docker "$TARGET_USER"

say "5/6 注册 qemu binfmt（WSL 专用 workaround）"
need_root install -m 0755 "$REPO_DIR/scripts/wsl-binfmt-setup.sh" /usr/local/bin/wsl-binfmt-setup.sh
need_root install -m 0644 "$REPO_DIR/scripts/wsl-binfmt.service" /etc/systemd/system/wsl-binfmt.service
need_root systemctl daemon-reload
need_root systemctl enable --now wsl-binfmt.service

say "6/6 创建 buildx 多架构 builder"
if docker buildx inspect neko >/dev/null 2>&1; then
    echo "builder 'neko' 已存在，跳过创建"
else
    docker buildx create \
        --name neko \
        --driver docker-container \
        --driver-opt network=host \
        --driver-opt "env.HTTP_PROXY=$PROXY" \
        --driver-opt "env.HTTPS_PROXY=$PROXY" \
        --config "$REPO_DIR/docker/buildkitd.toml" \
        --bootstrap
fi
docker buildx use neko || true

cat <<'EOF'

------------------------------------------------------------------
验证：
  docker run --rm --platform linux/arm64 alpine uname -m     # 期望 aarch64
  docker buildx ls                                           # 期望 neko* 且含 linux/arm64
  docker compose version
  docker info | grep -i 'http proxy'
------------------------------------------------------------------
提示：加入 docker 组后需重新登录 WSL 才生效（或临时使用 sudo docker）。
EOF
