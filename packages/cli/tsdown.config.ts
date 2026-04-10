import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts"],
  format: "esm",
  external: ["vite"],
  banner: { js: "#!/usr/bin/env node" },
});
