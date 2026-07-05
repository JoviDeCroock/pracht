import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  // prerender-module-hooks is a separate entry so the build command can pass
  // it to `module.register()` as a standalone file.
  entry: ["src/index.ts", "src/prerender-module-hooks.ts"],
  format: "esm",
  external: [/^@pracht\//, /^@modelcontextprotocol\//, /^node:/, "vite", "citty", "zod"],
});
