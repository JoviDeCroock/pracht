import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts"],
  format: "esm",
  external: [/^@pracht\//, /^node:/, "vite", "citty"],
});
