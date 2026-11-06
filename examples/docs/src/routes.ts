import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  shells: {
    home: () => import("./shells/home.tsx"),
    docs: () => import("./shells/docs.tsx"),
  },
  // The docs as read-only MCP tools, at https://pracht.resynapse.dev/mcp.
  // Served from the same content collection as the pages and llms.txt.
  capabilities: {
    "docs.search": () => import("./capabilities/docs-search.ts"),
    "docs.read": () => import("./capabilities/docs-read.ts"),
    "docs.list": () => import("./capabilities/docs-list.ts"),
  },
  agents: {
    mcp: {
      serverInfo: { name: "pracht-docs", version: "1.0.0" },
      instructions:
        "Documentation for pracht, a full-stack Preact framework. Search with docs_search, then read a page or one section with docs_read. docs_list is the table of contents.",
    },
  },
  routes: [
    group({ shell: "home" }, [
      route("/", () => import("./routes/home.tsx"), { id: "home", render: "ssg" }),
    ]),
    group({ shell: "docs", render: "ssg", hydration: "islands" }, [
      route("/docs", () => import("./routes/docs/index.tsx"), { id: "docs-index", render: "ssr" }),
      route("/docs/getting-started", () => import("./routes/docs/getting-started.md"), {
        id: "getting-started",
      }),
      route("/docs/why-pracht", () => import("./routes/docs/why-pracht.md"), {
        id: "why-pracht",
      }),
      route("/docs/demo-comparison", () => import("./routes/docs/demo-comparison.md"), {
        id: "demo-comparison",
      }),
      route("/docs/routing", () => import("./routes/docs/routing.md"), {
        id: "routing",
      }),
      route("/docs/rendering", () => import("./routes/docs/rendering.md"), {
        id: "rendering",
      }),
      route("/docs/islands", () => import("./routes/docs/islands.md"), {
        id: "islands",
      }),
      route("/docs/server-islands", () => import("./routes/docs/server-islands.md"), {
        id: "server-islands",
      }),
      route("/docs/data-loading", () => import("./routes/docs/data-loading.md"), {
        id: "data-loading",
      }),
      route("/docs/content", () => import("./routes/docs/content.md"), {
        id: "content",
      }),
      route("/docs/api-routes", () => import("./routes/docs/api-routes.md"), {
        id: "api-routes",
      }),
      route("/docs/api-validation", () => import("./routes/docs/api-validation.md"), {
        id: "api-validation",
      }),
      route("/docs/openapi", () => import("./routes/docs/openapi.md"), {
        id: "openapi",
      }),
      route("/docs/middleware", () => import("./routes/docs/middleware.md"), {
        id: "middleware",
      }),
      route("/docs/shells", () => import("./routes/docs/shells.md"), {
        id: "shells",
      }),
      route("/docs/styling", () => import("./routes/docs/styling.md"), {
        id: "styling",
      }),
      route("/docs/fonts", () => import("./routes/docs/fonts.md"), {
        id: "fonts",
      }),
      route("/docs/images", () => import("./routes/docs/images.md"), {
        id: "images",
      }),
      route("/docs/env", () => import("./routes/docs/env.md"), {
        id: "env",
      }),
      route("/docs/cli", () => import("./routes/docs/cli.md"), {
        id: "cli",
      }),
      route("/docs/deployment", () => import("./routes/docs/deployment.md"), {
        id: "deployment",
      }),
      route("/docs/adapters", () => import("./routes/docs/adapters.md"), {
        id: "adapters",
      }),
      route("/docs/prefetching", () => import("./routes/docs/prefetching.md"), {
        id: "prefetching",
      }),
      route("/docs/performance", () => import("./routes/docs/performance.md"), {
        id: "performance",
      }),
      route("/docs/agents", () => import("./routes/docs/agents.md"), {
        id: "agents",
      }),
      route("/docs/capabilities", () => import("./routes/docs/capabilities.md"), {
        id: "capabilities",
      }),
      route(
        "/docs/standalone-capabilities",
        () => import("./routes/docs/standalone-capabilities.md"),
        {
          id: "standalone-capabilities",
        },
      ),
      route("/docs/agent-trust", () => import("./routes/docs/agent-trust.md"), {
        id: "agent-trust",
      }),
      route("/docs/coding-agents", () => import("./routes/docs/coding-agents.md"), {
        id: "coding-agents",
      }),
      route("/docs/recipes/i18n", () => import("./routes/docs/recipes-i18n.md"), {
        id: "recipes-i18n",
      }),
      route("/docs/recipes/auth", () => import("./routes/docs/recipes-auth.md"), {
        id: "recipes-auth",
      }),
      route("/docs/recipes/csp", () => import("./routes/docs/recipes-csp.md"), {
        id: "recipes-csp",
      }),
      route("/docs/recipes/forms", () => import("./routes/docs/recipes-forms.md"), {
        id: "recipes-forms",
      }),
      route(
        "/docs/recipes/tanstack-query",
        () => import("./routes/docs/recipes-tanstack-query.md"),
        {
          id: "recipes-tanstack-query",
        },
      ),
      route(
        "/docs/recipes/view-transitions",
        () => import("./routes/docs/recipes-view-transitions.md"),
        {
          id: "recipes-view-transitions",
        },
      ),
      route("/docs/recipes/testing", () => import("./routes/docs/recipes-testing.md"), {
        id: "recipes-testing",
      }),
      route("/docs/recipes/logging", () => import("./routes/docs/recipes-logging.md"), {
        id: "recipes-logging",
      }),
      route("/docs/recipes/streaming", () => import("./routes/docs/recipes-streaming.md"), {
        id: "recipes-streaming",
      }),
      route("/docs/recipes/fullstack-cloudflare", "./routes/docs/recipes-fullstack-cloudflare.md", {
        id: "recipes-fullstack-cloudflare",
      }),
      route("/docs/recipes/fullstack-vercel", "./routes/docs/recipes-fullstack-vercel.md", {
        id: "recipes-fullstack-vercel",
      }),
      route("/docs/migrate/nextjs", "./routes/docs/migrate-nextjs.md", {
        id: "migrate-nextjs",
      }),
      route("/docs/examples", "./routes/docs/examples.md", {
        id: "examples",
      }),
      route("/docs/reference/api", "./routes/docs/reference-api.md", {
        id: "reference-api",
      }),
      route("/docs/reference/config", "./routes/docs/reference-config.md", {
        id: "reference-config",
      }),
      route("/docs/reference/i18n", "./routes/docs/reference-i18n.md", {
        id: "reference-i18n",
      }),

      // Retired "Agents" pages. They stay routable and 308 to whichever page
      // absorbed them, so old links and bookmarks keep working. Not in the
      // nav, not in the sitemap, and absent from llms.txt because the content
      // collection only ever sees Markdown pages.
      route("/docs/llms", () => import("./routes/legacy-redirect.tsx"), {
        id: "legacy-llms",
        render: "ssr",
      }),
      route("/docs/agent-workflow", () => import("./routes/legacy-redirect.tsx"), {
        id: "legacy-agent-workflow",
        render: "ssr",
      }),
      route("/docs/agent-skills", () => import("./routes/legacy-redirect.tsx"), {
        id: "legacy-agent-skills",
        render: "ssr",
      }),
      route("/docs/mcp", () => import("./routes/legacy-redirect.tsx"), {
        id: "legacy-mcp",
        render: "ssr",
      }),
      route("/docs/remote-mcp", () => import("./routes/legacy-redirect.tsx"), {
        id: "legacy-remote-mcp",
        render: "ssr",
      }),
    ]),
  ],
});
