import { defineApp, group, route } from "@pracht/core";

/**
 * Everything here has to be renderable at build time: the deployment is a
 * directory of files with no server behind it.
 *
 * - `ssg` pages are prerendered, and their loader results are written next to
 *   them so client navigation stays client-side.
 * - `spa` pages ship the shell plus its `Loading()` placeholder and render in
 *   the browser. `/projects/:id` is dynamic, so one fallback document answers
 *   every project URL.
 * - `ssr`, `isg`, and API routes would fail the build.
 */
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
      route("/docs/:slug", () => import("./routes/doc.tsx"), {
        id: "doc",
        render: "ssg",
      }),
      // No JavaScript at all: the page is pure HTML.
      route("/about", () => import("./routes/about.tsx"), {
        id: "about",
        render: "ssg",
        hydration: "none",
      }),
      // Static HTML with one interactive island.
      route("/counter", () => import("./routes/counter.tsx"), {
        id: "counter",
        render: "ssg",
        hydration: "islands",
      }),
      // Client-rendered. The document is the shell + Loading placeholder.
      route("/dashboard", () => import("./routes/dashboard.tsx"), {
        id: "dashboard",
        render: "spa",
      }),
      route("/projects/:id", () => import("./routes/project.tsx"), {
        id: "project",
        render: "spa",
      }),
    ]),
  ],
});
