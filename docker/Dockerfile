# syntax=docker/dockerfile:1.7
# NekoShelf 单镜像（amd64/arm64）：Node 24 + ffmpeg + 7zz；/data 只读、/config 与 /cache 可写。
# 运行时不带 TypeScript 源码：server 用 esbuild 打成 dist/，并安装 /usr/local/bin/nekoshelf 命令行。
#
# 构建（本机）：
#   wsl -d Ubuntu -- docker buildx build --builder neko --platform linux/amd64 -t nekoshelf:dev --load \

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
# 国内构建用清华源（deb.debian.org 直连过慢）；海外构建可删掉这行 sed
RUN sed -i 's|//deb.debian.org|//mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
 && corepack enable                       \
 && apt-get update                        \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# 依赖层：只复制清单，最大化缓存命中
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# 构建层：完整源码 + 前端产物 + server 打包产物
FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile \
 && pnpm --filter @nekoshelf/core build \
 && pnpm --filter @nekoshelf/adapters build \
 && pnpm --filter @nekoshelf/web build \
 && pnpm --filter @nekoshelf/server build

# 运行层
FROM base AS runtime
# 7zip 提供 7zz（zip/7z 列表与解压），p7zip-full 提供 7z（RAR3），libarchive-tools 提供 bsdtar（RAR5 兜底）
RUN sed -i 's|//deb.debian.org|//mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg 7zip p7zip-full libarchive-tools tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build /app/docs/api-contract.md ./docs/api-contract.md

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    HTTP_PORT=8080 \
    CONFIG_DIR=/config \
    CACHE_DIR=/cache \
    DATA_MODE=readonly \
    ENABLE_SCRAPER=false \
    SCAN_ON_START=false \
    UNMATCHED_VIDEO_POLICY=skip \
    SCAN_DELAY_MS=0 \
    TZ=Asia/Shanghai

# 容器内命令行：nekoshelf health / libraries / scan / token:create …
RUN mkdir -p /data /config /cache \
 && printf '%s\n' '#!/bin/sh' 'exec node /app/apps/server/dist/cli.js "$@"' > /usr/local/bin/nekoshelf \
 && chmod +x /usr/local/bin/nekoshelf \
 && chown -R node:node /config /cache

USER node
EXPOSE 8080
VOLUME ["/data", "/config", "/cache"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["/usr/bin/tini", "--", "node", "/app/apps/server/dist/index.js"]
