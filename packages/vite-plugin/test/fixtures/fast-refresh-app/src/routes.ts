import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  shells: { public: "./shells/public.tsx" },
  routes: [route("/", "./routes/home.tsx", { id: "home", render: "ssr", shell: "public" })],
});
