import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  shells: {
    public: () => import("./shells/public.tsx"),
  },
  routes: [
    group({ shell: "public" }, [
      route("/", () => import("./routes/home.tsrx"), { id: "home", render: "ssg" }),
      route("/about", () => import("./routes/about.tsx"), { id: "about", render: "ssg" }),
    ]),
  ],
});
