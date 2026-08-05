import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";
import { prachtOpenApi } from "@pracht/openapi/vite";

export default defineConfig({
  plugins: [
    pracht({
      adapter: cloudflareAdapter({
        workerExportsFrom: "/src/cloudflare.ts",
        cache: true,
      }),
      llmsTxt: { title: "Pracht Cloudflare Example" },
    }),
    prachtOpenApi({
      info: { title: "Pracht Cloudflare Example API", version: "1.0.0" },
      ui: "scalar",
    }),
  ],
});
