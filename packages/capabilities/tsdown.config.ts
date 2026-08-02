import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts", "src/static.ts"],
  format: "esm",
  dts: true,
});
