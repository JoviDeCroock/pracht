import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
  external: ["@pracht/core"],
  outputOptions: { comments: { jsdoc: false } },
});
