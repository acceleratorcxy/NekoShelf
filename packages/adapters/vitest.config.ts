import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const coreSrc = fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url));
const adaptersSrc = fileURLToPath(new URL("./src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@nekoshelf/core": coreSrc,
      "@nekoshelf/adapters": adaptersSrc,
    },
  },
});
