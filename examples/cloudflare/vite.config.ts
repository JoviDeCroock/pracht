import { defineConfig } from "vite";
import { previte } from "@previte/vite-plugin";
import { cloudflareAdapter } from "@previte/adapter-cloudflare";

export default defineConfig({
  plugins: [previte({ adapter: cloudflareAdapter() })],
});
