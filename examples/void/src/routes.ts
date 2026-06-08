import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  shells: {
    public: () => import("./shells/public.tsx"),
  },
  routes: [
    route("/", () => import("./routes/home.tsx"), {
      id: "home",
      render: "ssg",
      shell: "public",
    }),
    route("/bindings", () => import("./routes/bindings.tsx"), {
      id: "bindings",
      render: "ssr",
      shell: "public",
    }),
  ],
});
