import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  shells: {
    site: () => import("./shells/site.tsx"),
  },
  routes: [
    group({ shell: "site" }, [
      // Mostly-static SSG page with one eagerly-hydrated counter island.
      route("/", () => import("./routes/home.tsx"), {
        id: "home",
        render: "ssg",
        hydration: "islands",
      }),
      // Below-the-fold island using the `visible` strategy: its chunk is only
      // fetched and hydrated once it scrolls into view.
      route("/lazy", () => import("./routes/lazy.tsx"), {
        id: "lazy",
        render: "ssg",
        hydration: "islands",
      }),
      // Fully static page: no JavaScript is injected at all.
      route("/static", () => import("./routes/static-page.tsx"), {
        id: "static",
        render: "ssg",
        hydration: "none",
      }),
      // Islands also work with SSR: rendered per request, hydrating only the
      // islands on the page.
      route("/ssr", () => import("./routes/server-time.tsx"), {
        id: "server-time",
        render: "ssr",
        hydration: "islands",
      }),
      // Regular full-hydration route, proving both worlds coexist in one app.
      route("/full", () => import("./routes/full.tsx"), {
        id: "full",
        render: "ssg",
      }),
    ]),
  ],
});
