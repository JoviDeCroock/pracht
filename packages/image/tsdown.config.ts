import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts", "src/node.ts", "src/vite.ts"],
  format: "esm",
  dts: true,
  external: ["preact", "sharp", "vite", /^node:/],
});
