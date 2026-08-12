import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { staticAdapter } from "@pracht/adapter-static";

export default defineConfig({
  plugins: [
    pracht({
      adapter: staticAdapter(
        // The e2e suite opts into the SPA fallback document; a real app would
        // just write `staticAdapter({ fallback: "200.html" })`.
        process.env.PRACHT_STATIC_FALLBACK ? { fallback: process.env.PRACHT_STATIC_FALLBACK } : {},
      ),
    }),
  ],
});
