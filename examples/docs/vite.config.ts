import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";
import { markdown } from "./vite-plugin-md";
import { sitemap } from "./vite-plugin-sitemap";
import { agentSkills } from "./vite-plugin-agent-skills";

const SITE_ORIGIN = "https://pracht.resynapse.dev";
const routesFile = fileURLToPath(new URL("./src/routes.ts", import.meta.url));
const skillsDir = fileURLToPath(new URL("../../skills", import.meta.url));

export default defineConfig({
  plugins: [
    markdown(),
    sitemap({ origin: SITE_ORIGIN, routesFile }),
    agentSkills({ origin: SITE_ORIGIN, skillsDir }),
    pracht({
      adapter: cloudflareAdapter(),
      llmsTxt: {
        origin: SITE_ORIGIN,
        title: "pracht",
        description:
          "A full-stack Preact framework built on Vite with hybrid rendering (SSG, SSR, ISG, SPA) and a unified data-loading model.",
        details:
          "Each documentation URL is also available as source Markdown by following its `.md` link.",
        markdownSuffix: true,
        full: true,
        page: ({ path, data }) => {
          if (!path.startsWith("/docs") || typeof data.markdown !== "string") return false;
          const frontmatter =
            data.markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
          const field = (name: string) =>
            frontmatter
              .match(new RegExp(`^${name}:\\s*(.*)$`, "m"))?.[1]
              ?.replace(/^["']|["']$/g, "")
              .trim();
          return {
            title: field("title") || path,
            description: field("lead"),
            section: "Docs",
          };
        },
        render: ({ data }) => {
          if (typeof data.markdown !== "string") return undefined;
          return data.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
        },
      },
    }),
  ],
});
