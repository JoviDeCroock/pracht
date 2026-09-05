import { defineConfig } from "vite";
import { nodeAdapter } from "@pracht/adapter-node";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  // The alias a real migration adds so React-authored dependencies resolve.
  // The fixture's own component imports `preact/compat` directly, which is
  // what the alias resolves to — the measured bytes are the same either way,
  // and this way the fixture typechecks without React's type packages.
  resolve: {
    alias: {
      "react-dom/test-utils": "preact/test-utils",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
      react: "preact/compat",
    },
  },
  plugins: [pracht({ adapter: nodeAdapter() })],
});
