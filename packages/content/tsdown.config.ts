import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts", "src/capabilities.ts", "src/runtime.ts", "src/vite.ts"],
  format: "esm",
  dts: true,
  external: ["@pracht/capabilities", "vite", "yaml", /^node:/],
});
