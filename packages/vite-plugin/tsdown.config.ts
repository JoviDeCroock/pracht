import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/pages-router.ts"],
  format: "esm",
  dts: true,
  external: ["vite", "previte", /^node:/],
});
