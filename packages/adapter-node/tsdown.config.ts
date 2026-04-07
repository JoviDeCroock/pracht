import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
  external: ["previte", "@previte/vite-plugin", /^node:/],
});
