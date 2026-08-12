import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
  external: [
    /^@pracht\/core(\/.*)?$/,
    /^@pracht\/adapter-node(\/.*)?$/,
    "@pracht/vite-plugin",
    /^node:/,
  ],
});
