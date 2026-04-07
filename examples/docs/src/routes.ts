import { defineApp, group, route } from "viact";

export const app = defineApp({
  shells: {
    home: "./shells/home.tsx",
    docs: "./shells/docs.tsx",
  },
  routes: [
    group({ shell: "home" }, [route("/", "./routes/home.tsx", { id: "home", render: "ssg" })]),
    group({ shell: "docs" }, [
      route("/docs", "./routes/docs/index.tsx", { id: "docs-index", render: "ssr" }),
      route("/docs/getting-started", "./routes/docs/getting-started.md", {
        id: "getting-started",
        render: "ssg",
      }),
      route("/docs/routing", "./routes/docs/routing.md", {
        id: "routing",
        render: "ssg",
      }),
      route("/docs/rendering", "./routes/docs/rendering.md", {
        id: "rendering",
        render: "ssg",
      }),
      route("/docs/data-loading", "./routes/docs/data-loading.md", {
        id: "data-loading",
        render: "ssg",
      }),
      route("/docs/api-routes", "./routes/docs/api-routes.md", {
        id: "api-routes",
        render: "ssg",
      }),
      route("/docs/middleware", "./routes/docs/middleware.md", {
        id: "middleware",
        render: "ssg",
      }),
      route("/docs/shells", "./routes/docs/shells.md", {
        id: "shells",
        render: "ssg",
      }),
      route("/docs/cli", "./routes/docs/cli.md", {
        id: "cli",
        render: "ssg",
      }),
      route("/docs/deployment", "./routes/docs/deployment.md", {
        id: "deployment",
        render: "ssg",
      }),
      route("/docs/adapters", "./routes/docs/adapters.md", {
        id: "adapters",
        render: "ssg",
      }),
      route("/docs/prefetching", "./routes/docs/prefetching.md", {
        id: "prefetching",
        render: "ssg",
      }),
      route("/docs/performance", "./routes/docs/performance.md", {
        id: "performance",
        render: "ssg",
      }),
      route("/docs/recipes/i18n", "./routes/docs/recipes-i18n.md", {
        id: "recipes-i18n",
        render: "ssg",
      }),
      route("/docs/recipes/auth", "./routes/docs/recipes-auth.md", {
        id: "recipes-auth",
        render: "ssg",
      }),
      route("/docs/recipes/forms", "./routes/docs/recipes-forms.md", {
        id: "recipes-forms",
        render: "ssg",
      }),
      route("/docs/recipes/testing", "./routes/docs/recipes-testing.md", {
        id: "recipes-testing",
        render: "ssg",
      }),
    ]),
  ],
});
