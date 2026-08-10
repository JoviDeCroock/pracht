import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { vercelAdapter } from "@pracht/adapter-vercel";

export default defineConfig({
  plugins: [
    pracht({
      adapter: vercelAdapter(),
      // Emitted from the resolved app graph, so it always matches what the app
      // actually serves: pages, API endpoints, and HTTP-exposed capabilities.
      llmsTxt: {
        title: "Launchpad",
        description:
          "A Pracht showcase. Project management for humans, with the same operations exposed to agents as typed capabilities.",
      },
    }),
  ],
});
