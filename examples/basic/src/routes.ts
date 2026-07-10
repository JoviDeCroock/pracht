import { defineApp, group, route, timeRevalidate } from "@pracht/core";

export const app = defineApp({
  shells: {
    app: () => import("./shells/app.tsx"),
    public: () => import("./shells/public.tsx"),
  },
  middleware: {
    auth: () => import("./middleware/auth.ts"),
  },
  capabilities: {
    "notes.search": () => import("./capabilities/notes-search.ts"),
    "notes.create": () => import("./capabilities/notes-create.ts"),
    "notes.purge": () => import("./capabilities/notes-purge.ts"),
    "agent.whoami": () => import("./capabilities/agent-whoami.ts"),
    "agent.ping": () => import("./capabilities/agent-ping.ts"),
  },
  agents: {
    // Web Bot Auth: verify RFC 9421 agent signatures and surface the identity
    // as `context.agent`. The key below is the e2e suite's test agent — a
    // *public* Ed25519 key, safe to commit. "observe" serves unsigned callers
    // too; `agent.ping` opts into "require" per capability.
    webBotAuth: {
      policy: "observe",
      keys: [{ x: "s5n91rPm5ymJjl--scT4WWq7HE9kUdj-6sVe5r__xgc", agent: "test-agent.example" }],
    },
    confirmation: {
      ttlSeconds: 120,
    },
  },
  routes: [
    group({ shell: "public" }, [
      route("/", () => import("./routes/home.tsx"), { id: "home", render: "ssg" }),
      route("/notes", () => import("./routes/notes.tsx"), { id: "notes", render: "ssr" }),
      route("/products/:productId", () => import("./routes/product.tsx"), {
        id: "product",
        render: "ssg",
      }),
      route("/pricing", () => import("./routes/pricing.tsx"), {
        id: "pricing",
        render: "isg",
        revalidate: timeRevalidate(3600),
      }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", () => import("./routes/dashboard.tsx"), {
        id: "dashboard",
        render: "ssr",
      }),
      route("/settings", () => import("./routes/settings.tsx"), {
        id: "settings",
        render: "spa",
      }),
    ]),
  ],
});
