import { defineApp, group, route, timeRevalidate } from "@pracht/core";

export const app = defineApp({
  shells: {
    app: () => import("./shells/app.tsx"),
    public: () => import("./shells/public.tsx"),
  },
  middleware: {
    auth: () => import("./middleware/auth.ts"),
  },
  routes: [
    group({ shell: "public" }, [
      route("/", () => import("./routes/home.tsx"), {
        id: "home",
        render: "ssg",
        speculation: "prefetch",
      }),
      route("/products/:productId", () => import("./routes/product.tsx"), {
        id: "product",
        render: "ssg",
        speculation: "prerender",
      }),
      route("/pricing", () => import("./routes/pricing.tsx"), {
        id: "pricing",
        render: "isg",
        revalidate: timeRevalidate(3600),
        speculation: "prefetch",
      }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", () => import("./routes/dashboard.tsx"), {
        id: "dashboard",
        render: "ssr",
      }),
      route("/settings", () => import("./routes/settings.tsx"), {
        id: "settings",
        render: "spa",
      }),
    ]),
  ],
});
