import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts", "src/node.ts"],
  format: "esm",
  dts: true,
  external: ["preact", "sharp"],
});
