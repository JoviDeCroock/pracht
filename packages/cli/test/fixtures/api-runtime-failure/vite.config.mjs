import { nodeAdapter } from "../../../../adapter-node/dist/index.mjs";
import { pracht } from "../../../../vite-plugin/dist/index.mjs";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [pracht({ adapter: nodeAdapter(), appFile: "/src/routes.js" })],
});
