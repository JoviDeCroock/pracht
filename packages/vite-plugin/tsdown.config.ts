import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts", "src/pages-router.ts", "src/agent-skills.ts"],
  format: "esm",
  dts: true,
  external: ["vite", "@pracht/core", /^node:/],
});
