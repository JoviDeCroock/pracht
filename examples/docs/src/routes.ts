import { defineApp, group, route } from "viact";

export const app = defineApp({
  shells: {
    home: "./shells/home.tsx",
    docs: "./shells/docs.tsx",
  },
  routes: [
    group({ shell: "home" }, [route("/", () => import("./routes/home.tsx"), { id: "home", render: "ssg" })]),
    group({ shell: "docs" }, [
      route("/docs", () => import("./routes/docs/index.tsx"), { id: "docs-index", render: "ssr" }),
      route("/docs/getting-started", () => import("./routes/docs/getting-started.tsx"), {
        id: "getting-started",
        render: "ssg",
      }),
      route("/docs/routing", () => import("./routes/docs/routing.tsx"), {
        id: "routing",
        render: "ssg",
      }),
      route("/docs/rendering", () => import("./routes/docs/rendering.tsx"), {
        id: "rendering",
        render: "ssg",
      }),
      route("/docs/data-loading", () => import("./routes/docs/data-loading.tsx"), {
        id: "data-loading",
        render: "ssg",
      }),
      route("/docs/api-routes", () => import("./routes/docs/api-routes.tsx"), {
        id: "api-routes",
        render: "ssg",
      }),
      route("/docs/middleware", () => import("./routes/docs/middleware.tsx"), {
        id: "middleware",
        render: "ssg",
      }),
      route("/docs/shells", () => import("./routes/docs/shells.tsx"), {
        id: "shells",
        render: "ssg",
      }),
      route("/docs/cli", () => import("./routes/docs/cli.tsx"), {
        id: "cli",
        render: "ssg",
      }),
      route("/docs/deployment", () => import("./routes/docs/deployment.tsx"), {
        id: "deployment",
        render: "ssg",
      }),
      route("/docs/adapters", () => import("./routes/docs/adapters.tsx"), {
        id: "adapters",
        render: "ssg",
      }),
      route("/docs/prefetching", () => import("./routes/docs/prefetching.tsx"), {
        id: "prefetching",
        render: "ssg",
      }),
      route("/docs/performance", () => import("./routes/docs/performance.tsx"), {
        id: "performance",
        render: "ssg",
      }),
      route("/docs/recipes/i18n", () => import("./routes/docs/recipes-i18n.tsx"), {
        id: "recipes-i18n",
        render: "ssg",
      }),
      route("/docs/recipes/auth", () => import("./routes/docs/recipes-auth.tsx"), {
        id: "recipes-auth",
        render: "ssg",
      }),
      route("/docs/recipes/forms", () => import("./routes/docs/recipes-forms.tsx"), {
        id: "recipes-forms",
        render: "ssg",
      }),
      route("/docs/recipes/testing", () => import("./routes/docs/recipes-testing.tsx"), {
        id: "recipes-testing",
        render: "ssg",
      }),
    ]),
  ],
});
