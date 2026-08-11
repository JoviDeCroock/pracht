import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
  external: [
    /^@netlify\/functions(\/.*)?$/,
    /^@pracht\/core(\/.*)?$/,
    "@pracht/vite-plugin",
    /^node:/,
    "vite",
  ],
});
