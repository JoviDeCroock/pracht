import { defineApp, group, route, timeRevalidate } from "previte";

export const app = defineApp({
  shells: {
    app: "./shells/app.tsx",
    public: "./shells/public.tsx",
  },
  middleware: {
    auth: "./middleware/auth.ts",
  },
  routes: [
    group({ shell: "public" }, [
      route("/", "./routes/home.tsx", { id: "home", render: "ssg" }),
      route("/pricing", "./routes/pricing.tsx", {
        id: "pricing",
        render: "isg",
        revalidate: timeRevalidate(3600),
      }),
      route("/products/:id", "./routes/products/[id].tsx", {
        id: "product",
        render: "ssr",
      }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", "./routes/dashboard.tsx", {
        id: "dashboard",
        render: "ssr",
      }),
      route("/settings", "./routes/settings.tsx", {
        id: "settings",
        render: "spa",
      }),
    ]),
  ],
});
