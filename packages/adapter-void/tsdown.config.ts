import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
  external: ["@pracht/adapter-cloudflare", "@pracht/vite-plugin", /^void(\/.*)?$/, /^node:/],
});
