import { cloudflareAdapter } from "../../../../adapter-cloudflare/dist/index.mjs";
import { pracht } from "../../../../vite-plugin/dist/index.mjs";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [pracht({ adapter: cloudflareAdapter() })],
});
