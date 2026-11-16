import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const coreSrc = fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url));
const adaptersSrc = fileURLToPath(new URL("../../packages/adapters/src/index.ts", import.meta.url));

// 刮削集成测试里有 2s 最小请求间隔（EhClient 规则），给足超时。
// workspace 包在运行时走 dist（见 Dockerfile 构建阶段），测试里直接映射到源码，先跑测试后构建也没问题。
export default defineConfig({
  resolve: {
    alias: {
      "@nekoshelf/core": coreSrc,
      "@nekoshelf/adapters": adaptersSrc,
    },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
