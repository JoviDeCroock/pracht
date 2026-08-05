import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts", "src/vite.ts"],
  format: "esm",
  dts: true,
  external: ["@pracht/core", "vite", /^node:/],
});
