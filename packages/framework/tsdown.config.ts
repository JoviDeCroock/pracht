import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: [
    "src/index.ts",
    "src/browser.ts",
    "src/client.ts",
    "src/manifest.ts",
    "src/server.ts",
    "src/error-overlay.ts",
    "src/dev-404.ts",
  ],
  format: "esm",
  dts: true,
  external: ["preact", "preact/hooks", "preact-render-to-string"],
});
