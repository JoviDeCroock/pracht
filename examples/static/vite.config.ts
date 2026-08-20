import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { staticAdapter } from "@pracht/adapter-static";

export default defineConfig({
  plugins: [
    pracht({
      adapter: staticAdapter(
        // The e2e suite opts into the SPA fallback document; a real app would
        // configure the same shared metadata explicitly when dynamic routes
        // or their shells export head().
        process.env.PRACHT_STATIC_FALLBACK
          ? {
              fallback: process.env.PRACHT_STATIC_FALLBACK,
              fallbackHead: {
                meta: [{ content: "width=device-width, initial-scale=1", name: "viewport" }],
                title: "Pracht Static Example",
              },
            }
          : {},
      ),
    }),
  ],
});
