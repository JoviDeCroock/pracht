import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: [
    "src/index.ts",
    "src/browser.ts",
    "src/client.ts",
    "src/manifest.ts",
    "src/env.ts",
    "src/env-server.ts",
    "src/env-server.browser.ts",
    "src/server.ts",
    "src/islands-client.ts",
    "src/error-overlay.ts",
    "src/dev-404.ts",
    "src/devtools.ts",
  ],
  format: "esm",
  dts: true,
  external: ["preact", "preact/hooks", "preact-render-to-string"],
});
