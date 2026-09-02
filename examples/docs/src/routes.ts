import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  shells: {
    home: () => import("./shells/home.tsx"),
    docs: () => import("./shells/docs.tsx"),
  },
  routes: [
    group({ shell: "home" }, [
      route("/", () => import("./routes/home.tsx"), { id: "home", render: "ssg" }),
    ]),
    group({ shell: "docs" }, [
      route("/docs", () => import("./routes/docs/index.tsx"), { id: "docs-index", render: "ssr" }),
      route("/docs/getting-started", () => import("./routes/docs/getting-started.md"), {
        id: "getting-started",
        render: "ssg",
      }),
      route("/docs/why-pracht", () => import("./routes/docs/why-pracht.md"), {
        id: "why-pracht",
        render: "ssg",
      }),
      route("/docs/demo-comparison", () => import("./routes/docs/demo-comparison.md"), {
        id: "demo-comparison",
        render: "ssg",
      }),
      route("/docs/routing", () => import("./routes/docs/routing.md"), {
        id: "routing",
        render: "ssg",
      }),
      route("/docs/rendering", () => import("./routes/docs/rendering.md"), {
        id: "rendering",
        render: "ssg",
      }),
      route("/docs/islands", () => import("./routes/docs/islands.md"), {
        id: "islands",
        render: "ssg",
        hydration: "islands",
      }),
      route("/docs/data-loading", () => import("./routes/docs/data-loading.md"), {
        id: "data-loading",
        render: "ssg",
      }),
      route("/docs/content", () => import("./routes/docs/content.md"), {
        id: "content",
        render: "ssg",
      }),
      route("/docs/api-routes", () => import("./routes/docs/api-routes.md"), {
        id: "api-routes",
        render: "ssg",
      }),
      route("/docs/api-validation", () => import("./routes/docs/api-validation.md"), {
        id: "api-validation",
        render: "ssg",
      }),
      route("/docs/openapi", () => import("./routes/docs/openapi.md"), {
        id: "openapi",
        render: "ssg",
      }),
      route("/docs/middleware", () => import("./routes/docs/middleware.md"), {
        id: "middleware",
        render: "ssg",
      }),
      route("/docs/shells", () => import("./routes/docs/shells.md"), {
        id: "shells",
        render: "ssg",
      }),
      route("/docs/styling", () => import("./routes/docs/styling.md"), {
        id: "styling",
        render: "ssg",
      }),
      route("/docs/fonts", () => import("./routes/docs/fonts.md"), {
        id: "fonts",
        render: "ssg",
      }),
      route("/docs/images", () => import("./routes/docs/images.md"), {
        id: "images",
        render: "ssg",
        hydration: "none",
      }),
      route("/docs/env", () => import("./routes/docs/env.md"), {
        id: "env",
        render: "ssg",
      }),
      route("/docs/cli", () => import("./routes/docs/cli.md"), {
        id: "cli",
        render: "ssg",
      }),
      route("/docs/deployment", () => import("./routes/docs/deployment.md"), {
        id: "deployment",
        render: "ssg",
      }),
      route("/docs/adapters", () => import("./routes/docs/adapters.md"), {
        id: "adapters",
        render: "ssg",
      }),
      route("/docs/prefetching", () => import("./routes/docs/prefetching.md"), {
        id: "prefetching",
        render: "ssg",
      }),
      route("/docs/performance", () => import("./routes/docs/performance.md"), {
        id: "performance",
        render: "ssg",
      }),
      route("/docs/agents", () => import("./routes/docs/agents.md"), {
        id: "agents",
        render: "ssg",
      }),
      route("/docs/capabilities", () => import("./routes/docs/capabilities.md"), {
        id: "capabilities",
        render: "ssg",
      }),
      route(
        "/docs/standalone-capabilities",
        () => import("./routes/docs/standalone-capabilities.md"),
        {
          id: "standalone-capabilities",
          render: "ssg",
        },
      ),
      route("/docs/agent-trust", () => import("./routes/docs/agent-trust.md"), {
        id: "agent-trust",
        render: "ssg",
      }),
      route("/docs/coding-agents", () => import("./routes/docs/coding-agents.md"), {
        id: "coding-agents",
        render: "ssg",
      }),
      route("/docs/recipes/i18n", () => import("./routes/docs/recipes-i18n.md"), {
        id: "recipes-i18n",
        render: "ssg",
      }),
      route("/docs/recipes/auth", () => import("./routes/docs/recipes-auth.md"), {
        id: "recipes-auth",
        render: "ssg",
      }),
      route("/docs/recipes/csp", () => import("./routes/docs/recipes-csp.md"), {
        id: "recipes-csp",
        render: "ssg",
      }),
      route("/docs/recipes/forms", () => import("./routes/docs/recipes-forms.md"), {
        id: "recipes-forms",
        render: "ssg",
      }),
      route(
        "/docs/recipes/view-transitions",
        () => import("./routes/docs/recipes-view-transitions.md"),
        {
          id: "recipes-view-transitions",
          render: "ssg",
        },
      ),
      route("/docs/recipes/testing", () => import("./routes/docs/recipes-testing.md"), {
        id: "recipes-testing",
        render: "ssg",
      }),
      route("/docs/recipes/logging", () => import("./routes/docs/recipes-logging.md"), {
        id: "recipes-logging",
        render: "ssg",
      }),
      route("/docs/recipes/streaming", () => import("./routes/docs/recipes-streaming.md"), {
        id: "recipes-streaming",
        render: "ssg",
      }),
      route("/docs/recipes/fullstack-cloudflare", "./routes/docs/recipes-fullstack-cloudflare.md", {
        id: "recipes-fullstack-cloudflare",
        render: "ssg",
      }),
      route("/docs/recipes/fullstack-vercel", "./routes/docs/recipes-fullstack-vercel.md", {
        id: "recipes-fullstack-vercel",
        render: "ssg",
      }),
      route("/docs/migrate/nextjs", "./routes/docs/migrate-nextjs.md", {
        id: "migrate-nextjs",
        render: "ssg",
      }),
      route("/docs/examples", "./routes/docs/examples.md", {
        id: "examples",
        render: "ssg",
      }),
      route("/docs/reference/api", "./routes/docs/reference-api.md", {
        id: "reference-api",
        render: "ssg",
      }),
      route("/docs/reference/config", "./routes/docs/reference-config.md", {
        id: "reference-config",
        render: "ssg",
      }),
      route("/docs/reference/i18n", "./routes/docs/reference-i18n.md", {
        id: "reference-i18n",
        render: "ssg",
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
