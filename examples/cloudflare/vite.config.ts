import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";

export default defineConfig({
  plugins: [
    pracht({
      adapter: cloudflareAdapter({
        exports: [{ from: "/src/workers/counter.ts", names: ["Counter"] }],
      }),
    }),
  ],
});
