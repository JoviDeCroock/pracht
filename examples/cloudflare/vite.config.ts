import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";

const e2eInspectorPort = process.env.PRACHT_E2E_INSPECTOR_PORT;

export default defineConfig({
  plugins: [
    pracht({
      adapter: cloudflareAdapter({
        workerExportsFrom: "/src/cloudflare.ts",
        cache: true,
        // Playwright leases this alongside its HTTP ports so concurrent suites
        // cannot race Cloudflare's inspector probe or shared persisted state.
        inspectorPort: e2eInspectorPort ? Number(e2eInspectorPort) : undefined,
        persistState: e2eInspectorPort ? false : undefined,
      }),
      llmsTxt: { title: "Pracht Cloudflare Example" },
    }),
  ],
});
