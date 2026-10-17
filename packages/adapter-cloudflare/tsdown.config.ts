import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts", "src/runtime.ts", "src/cache.ts", "src/worker.ts"],
  format: "esm",
  dts: true,
  external: [/^@pracht\/core(\/.*)?$/, /^node:/, /^cloudflare:/, "vite"],
});
