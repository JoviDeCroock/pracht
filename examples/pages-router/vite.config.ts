import { defineConfig } from "vite";
import { previte } from "@previte/vite-plugin";

async function resolveAdapter() {
  const { nodeAdapter } = await import("@previte/adapter-node");
  return nodeAdapter();
}

export default defineConfig(async () => ({
  plugins: [previte({ pagesDir: "/src/pages", adapter: await resolveAdapter() })],
}));
