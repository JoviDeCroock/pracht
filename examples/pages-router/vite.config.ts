import { defineConfig } from "vite";
import { prachtOpenApi } from "@pracht/openapi/vite";
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
    prachtOpenApi({
      info: { title: "Pracht Pages Example API", version: "1.0.0" },
      ui: "scalar",
    }),
  ],
}));
