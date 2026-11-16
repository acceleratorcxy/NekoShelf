#!/bin/sh
# WSL 环境下 systemd-binfmt.service 因 ConditionVirtualization=!wsl 被跳过，
# 导致 qemu-user-static 的 binfmt 处理器不会注册，arm64 容器执行会报
# "exec format error"。本脚本幂等注册 qemu-<arch> 处理器。
#
# 用法（在 WSL 的 Ubuntu 里）：
#   sudo /usr/local/bin/wsl-binfmt-setup.sh
set -u

BINFMT_MNT=/proc/sys/fs/binfmt_misc

register_arch() {
    arch="$1"
    conf="/usr/lib/binfmt.d/qemu-${arch}.conf"
    [ -f "$conf" ] || return 0
    [ -e "${BINFMT_MNT}/qemu-${arch}" ] && return 0

    tmp="$(mktemp)"
    # 把 OPF 换成 PF：追加 F（fix binary）标志，注册后容器内可直接使用
    sed -e 's/:OPF$/:PF/' "$conf" >"$tmp"
    if cat "$tmp" >"${BINFMT_MNT}/register" 2>/dev/null; then
        echo "registered qemu-${arch}"
    else
        echo "register failed: qemu-${arch}" >&2
    fi
    rm -f "$tmp"
}

if ! mountpoint -q "$BINFMT_MNT" 2>/dev/null; then
    mount -t binfmt_misc binfmt_misc "$BINFMT_MNT" 2>/dev/null || true
fi

for a in aarch64 arm armeb alpha mips mips64 ppc64le riscv64 s390x; do
    register_arch "$a"
done

echo "--- active handlers ---"
ls "$BINFMT_MNT" 2>/dev/null | grep '^qemu-' || echo "(none)"
