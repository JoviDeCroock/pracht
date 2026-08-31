import { defineApp, group, route } from "@pracht/core";

// Deliberately a separate app from the ladder fixture: `preact/compat` lands in
// the shared vendor chunk, so measuring it in the same build would inflate
// every other rung.
export const app = defineApp({
  shells: {
    site: () => import("./shells/site.tsx"),
  },
  routes: [
    group({ shell: "site" }, [
      route("/full", () => import("./routes/full-page.tsx"), { id: "full", render: "ssg" }),
    ]),
  ],
});
