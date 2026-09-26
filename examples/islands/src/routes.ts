import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  shells: {
    site: () => import("./shells/site.tsx"),
  },
  middleware: {
    visitor: () => import("./middleware/visitor.ts"),
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
      // Fully static as well, but with an island component on the page: it
      // renders as a plain component and its CSS still has to be linked.
      route("/static-island", () => import("./routes/static-island.tsx"), {
        id: "static-island",
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
      // Request-time regions: per-visitor content inside otherwise cached
      // pages. The region endpoint runs the `visitor` middleware of whichever
      // route embedded the region.
      group({ middleware: ["visitor"] }, [
        route("/regions", () => import("./routes/regions.tsx"), {
          id: "regions",
          render: "ssg",
          hydration: "none",
        }),
        route("/regions/ssr", () => import("./routes/regions.tsx"), {
          id: "regions-ssr",
          render: "ssr",
          hydration: "none",
        }),
        route("/regions/islands", () => import("./routes/regions-islands.tsx"), {
          id: "regions-islands",
          render: "ssg",
          hydration: "islands",
        }),
        route("/regions/full", () => import("./routes/regions-full.tsx"), {
          id: "regions-full",
          render: "ssg",
        }),
      ]),
    ]),
  ],
});
