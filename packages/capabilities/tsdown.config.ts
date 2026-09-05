import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: [
    "src/index.ts",
    "src/static.ts",
    "src/server.ts",
    "src/server-internal.ts",
    "src/webmcp.ts",
  ],
  format: "esm",
  dts: true,
});
