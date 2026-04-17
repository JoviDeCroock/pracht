import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";
import { markdown } from "./vite-plugin-md";
import { sitemap } from "./vite-plugin-sitemap";
import { agentSkills } from "./vite-plugin-agent-skills";
import { llmsTxt } from "./vite-plugin-llms-txt";

const SITE_ORIGIN = "https://pracht.dev";
const routesFile = fileURLToPath(new URL("./src/routes.ts", import.meta.url));
const skillsDir = fileURLToPath(new URL("../../skills", import.meta.url));

export default defineConfig({
  plugins: [
    markdown(),
    sitemap({ origin: SITE_ORIGIN, routesFile }),
    agentSkills({ origin: SITE_ORIGIN, skillsDir }),
    llmsTxt({
      origin: SITE_ORIGIN,
      routesFile,
      title: "pracht",
      description:
        "A full-stack Preact framework built on Vite with hybrid rendering (SSG, SSR, ISG, SPA) and a unified data-loading model.",
      sections: [{ heading: "Docs", match: "/docs" }],
    }),
    pracht({ adapter: cloudflareAdapter() }),
  ],
});
