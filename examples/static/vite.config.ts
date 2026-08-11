import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { staticAdapter, type StaticHost } from "@pracht/adapter-static";

// `PRACHT_STATIC_HOST=netlify|vercel|generic pracht build` selects which host
// configuration the build writes; the app itself is identical either way.
const host = (process.env.PRACHT_STATIC_HOST ?? "netlify") as StaticHost;

export default defineConfig({
  plugins: [
    pracht({
      adapter: staticAdapter({ host }),
      llmsTxt: {
        title: "Pracht Static Example",
        description: "SSG, islands, and SPA routes deployed with no server runtime.",
      },
    }),
  ],
});
