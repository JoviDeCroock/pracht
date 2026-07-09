import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@pracht/core/server": new URL("./packages/framework/src/server.ts", import.meta.url)
        .pathname,
      "@pracht/core": new URL("./packages/framework/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    exclude: ["**/node_modules/**", "e2e/**"],
  },
});
