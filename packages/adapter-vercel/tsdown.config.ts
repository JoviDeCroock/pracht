import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  // build-output is Node-only and loaded at build time through an import the
  // app bundler cannot follow, so it never reaches the edge server bundle.
  entry: ["src/index.ts", "src/build-output.ts"],
  format: "esm",
  dts: true,
  external: [/^@pracht\/core(\/.*)?$/, /^node:/, "vite"],
  outputOptions: { comments: { jsdoc: false } },
});
