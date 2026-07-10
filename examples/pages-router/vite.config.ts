import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

async function resolveAdapter() {
  const { nodeAdapter } = await import("@pracht/adapter-node");
  return nodeAdapter();
}

export default defineConfig(async () => ({
  plugins: [
    pracht({
      pagesDir: "/src/pages",
      adapter: await resolveAdapter(),
      llmsTxt: { title: "Pracht Pages Example" },
    }),
  ],
}));
