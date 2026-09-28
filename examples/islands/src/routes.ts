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
      // Server islands: per-visitor content inside otherwise cached pages.
      // The server island endpoint runs the `visitor` middleware of the route
      // that renders the server island.
      group({ middleware: ["visitor"] }, [
        route("/server-islands", () => import("./routes/server-islands.tsx"), {
          id: "server-islands",
          render: "ssg",
          hydration: "none",
        }),
        route("/server-islands/ssr", () => import("./routes/server-islands.tsx"), {
          id: "server-islands-ssr",
          render: "ssr",
          hydration: "none",
        }),
        route("/server-islands/islands", () => import("./routes/server-islands-with-islands.tsx"), {
          id: "server-islands-islands",
          render: "ssg",
          hydration: "islands",
        }),
        route("/server-islands/full", () => import("./routes/server-islands-full.tsx"), {
          id: "server-islands-full",
          render: "ssg",
        }),
      ]),
    ]),
  ],
});
