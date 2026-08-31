import { defineApp, group, route } from "@pracht/core";

// Three routes, one shell, one interactive component, identical markup. The
// only variable across them is the hydration mode, so `pracht build --json`
// reports the framework's cost per rung rather than the app's.
export const app = defineApp({
  shells: {
    site: () => import("./shells/site.tsx"),
  },
  routes: [
    group({ shell: "site" }, [
      route("/none", () => import("./routes/static-page.tsx"), {
        id: "none",
        render: "ssg",
        hydration: "none",
      }),
      route("/islands", () => import("./routes/islands-page.tsx"), {
        id: "islands",
        render: "ssg",
        hydration: "islands",
      }),
      route("/full", () => import("./routes/full-page.tsx"), {
        id: "full",
        render: "ssg",
      }),
    ]),
  ],
});
