import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts", "src/bridge.ts"],
  format: "esm",
  dts: true,
  external: [/^@pracht\/core(\/.*)?$/, /^node:/, "vite"],
});
