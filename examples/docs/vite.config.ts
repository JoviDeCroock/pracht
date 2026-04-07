import { defineConfig } from "vite";
import { previte } from "@previte/vite-plugin";
import { cloudflareAdapter } from "@previte/adapter-cloudflare";
import { markdown } from "./vite-plugin-md";

export default defineConfig({
  plugins: [markdown(), previte({ adapter: cloudflareAdapter() })],
});
