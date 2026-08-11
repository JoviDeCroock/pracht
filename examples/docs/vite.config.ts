import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { prachtContent } from "@pracht/content/vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";
import { docsContent } from "./content";
import { sitemap } from "./vite-plugin-sitemap";
import { agentSkills } from "./vite-plugin-agent-skills";

const SITE_ORIGIN = "https://pracht.resynapse.dev";
const routesFile = fileURLToPath(new URL("./src/routes.ts", import.meta.url));
const skillsDir = fileURLToPath(new URL("../../skills", import.meta.url));

export default defineConfig({
  plugins: [
    prachtContent({ collections: [docsContent] }),
    sitemap({ origin: SITE_ORIGIN, routesFile }),
    agentSkills({ origin: SITE_ORIGIN, skillsDir }),
    pracht({ adapter: cloudflareAdapter() }),
  ],
});
