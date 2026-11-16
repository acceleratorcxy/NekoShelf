import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 包内测试直接用源码入口（不依赖 dist），保证「先测试后构建」也能通过。
const coreSrc = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@nekoshelf/core": coreSrc,
    },
  },
});
