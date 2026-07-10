import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts", "src/runtime.ts", "src/cache.ts"],
  format: "esm",
  dts: true,
  external: [/^@pracht\/core(\/.*)?$/, "@pracht/vite-plugin", /^node:/, /^cloudflare:/],
});
