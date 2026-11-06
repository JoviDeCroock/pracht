import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { prachtContent } from "@pracht/content/vite";
import { prachtImage } from "@pracht/image/vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";
import { docsContent } from "./content";
import { SITE_ORIGIN } from "./src/site";
import { sitemap } from "./vite-plugin-sitemap";
import { agentSkills } from "./vite-plugin-agent-skills";
import { docsIndex } from "./vite-plugin-docs-index";
import { searchIndex } from "./vite-plugin-search-index";

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
        // Redirects to the first docs page.
        "/docs",
        "/docs/llms",
        "/docs/agent-workflow",
        "/docs/agent-skills",
        "/docs/mcp",
        "/docs/remote-mcp",
      ],
    }),
    agentSkills({ origin: SITE_ORIGIN, skillsDir }),
    docsIndex({ collection: docsContent }),
    searchIndex({ collection: docsContent }),
    pracht({ adapter: cloudflareAdapter() }),
  ],
});
