import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts", "src/root.ts"],
  format: "esm",
  dts: true,
  external: [
    "@pracht/capabilities",
    "@pracht/core",
    "@tanstack/preact-query",
    "preact",
    "preact/hooks",
  ],
});
