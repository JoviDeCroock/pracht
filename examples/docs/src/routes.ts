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
      route("/docs/routing", () => import("./routes/docs/routing.md"), {
        id: "routing",
        render: "ssg",
      }),
      route("/docs/rendering", () => import("./routes/docs/rendering.md"), {
        id: "rendering",
        render: "ssg",
      }),
      route("/docs/data-loading", () => import("./routes/docs/data-loading.md"), {
        id: "data-loading",
        render: "ssg",
      }),
      route("/docs/api-routes", () => import("./routes/docs/api-routes.md"), {
        id: "api-routes",
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
      route("/docs/recipes/i18n", () => import("./routes/docs/recipes-i18n.md"), {
        id: "recipes-i18n",
        render: "ssg",
      }),
      route("/docs/recipes/auth", () => import("./routes/docs/recipes-auth.md"), {
        id: "recipes-auth",
        render: "ssg",
      }),
      route("/docs/recipes/forms", () => import("./routes/docs/recipes-forms.md"), {
        id: "recipes-forms",
        render: "ssg",
      }),
      route("/docs/recipes/testing", () => import("./routes/docs/recipes-testing.md"), {
        id: "recipes-testing",
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
    ]),
  ],
});
