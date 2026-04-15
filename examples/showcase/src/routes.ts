import { defineApp, group, route, timeRevalidate } from "@pracht/core";

export const app = defineApp({
  shells: {
    marketing: () => import("./shells/marketing.tsx"),
    app: () => import("./shells/app.tsx"),
  },
  middleware: {
    auth: () => import("./middleware/auth.ts"),
  },
  routes: [
    // Public marketing — static, CDN-fast, great SEO
    group({ shell: "marketing" }, [
      route("/", () => import("./routes/home.tsx"), {
        id: "home",
        render: "ssg",
      }),
      route("/blog/:slug", () => import("./routes/blog-post.tsx"), {
        id: "blog-post",
        render: "ssg",
      }),

      // Pricing changes when plans update — ISG keeps it fast AND fresh
      route("/pricing", () => import("./routes/pricing.tsx"), {
        id: "pricing",
        render: "isg",
        revalidate: timeRevalidate(3600),
      }),
    ]),

    // Authenticated app — personalized, interactive
    group({ shell: "app", middleware: ["auth"] }, [
      route("/app", () => import("./routes/dashboard.tsx"), {
        id: "dashboard",
        render: "ssr",
      }),
      route("/app/projects/:projectId", () => import("./routes/project.tsx"), {
        id: "project",
        render: "ssr",
      }),

      // Settings is pure client UI — no SEO, no server rendering needed
      route("/app/settings", () => import("./routes/settings.tsx"), {
        id: "settings",
        render: "spa",
      }),
    ]),
  ],
});
