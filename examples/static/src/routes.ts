import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  shells: {
    site: () => import("./shells/site.tsx"),
  },
  notFound: {
    component: () => import("./routes/not-found.tsx"),
    shell: "site",
  },
  routes: [
    group({ shell: "site" }, [
      route("/", () => import("./routes/home.tsx"), { id: "home", render: "ssg" }),
      route("/about", () => import("./routes/about.tsx"), { id: "about", render: "ssg" }),
      // No loader: navigation only fetches the shared shell's head state.
      route("/plain", () => import("./routes/plain.tsx"), { id: "plain", render: "ssg" }),
      // Dynamic SSG: getStaticPaths() enumerates the pages (and their
      // route-state files) at build time.
      route("/posts/:slug", () => import("./routes/post.tsx"), { id: "post", render: "ssg" }),
      // Static SPA routes are loaderless: their shell HTML is emitted at
      // build time and the component runs entirely in the browser.
      route("/dashboard", () => import("./routes/dashboard.tsx"), {
        id: "dashboard",
        render: "spa",
      }),
      // Dynamic loaderless SPA route: deep links only work behind a host
      // rewrite to the 200.html fallback.
      route("/items/:id", () => import("./routes/item.tsx"), { id: "item", render: "spa" }),
    ]),
  ],
});
