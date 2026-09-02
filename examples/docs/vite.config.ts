import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { prachtContent } from "@pracht/content/vite";
import { prachtImage } from "@pracht/image/vite";
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
    prachtImage(),
    sitemap({
      origin: SITE_ORIGIN,
      routesFile,
      // Retired "Agents" pages kept alive as redirects — see src/routes.ts.
      excludePaths: [
        "/docs/llms",
        "/docs/agent-workflow",
        "/docs/agent-skills",
        "/docs/mcp",
        "/docs/remote-mcp",
      ],
    }),
    agentSkills({ origin: SITE_ORIGIN, skillsDir }),
    pracht({ adapter: cloudflareAdapter() }),
  ],
});
