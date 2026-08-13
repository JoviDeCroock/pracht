import { defineApp, group, route, timeRevalidate, webhookRevalidate } from "@pracht/core";
import { cloudflareLoader, configureImage, passthroughLoader, vercelLoader } from "@pracht/image";

declare const __PRACHT_IMAGE_BACKEND__: string;

if (__PRACHT_IMAGE_BACKEND__ === "cloudflare") {
  configureImage({ loader: cloudflareLoader });
} else if (__PRACHT_IMAGE_BACKEND__ === "vercel") {
  configureImage({ loader: vercelLoader });
} else if (__PRACHT_IMAGE_BACKEND__ === "passthrough") {
  configureImage({ loader: passthroughLoader });
}

export const app = defineApp({
  shells: {
    app: () => import("./shells/app.tsx"),
    public: () => import("./shells/public.tsx"),
  },
  middleware: {
    auth: () => import("./middleware/auth.ts"),
    productMarkdown: () => import("./middleware/product-markdown.ts"),
  },
  notFound: {
    component: () => import("./routes/not-found.tsx"),
    shell: "public",
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
    // Serve the `expose.mcp` capabilities as MCP tools at /mcp, for agents
    // that never open a browser.
    mcp: {
      serverInfo: { name: "pracht-basic-example", version: "0.0.0" },
      instructions: "Search and create notes in the pracht basic example app.",
    },
  },
  routes: [
    group({ shell: "public" }, [
      route("/", () => import("./routes/home.tsx"), {
        id: "home",
        render: "ssg",
        speculation: "prefetch",
      }),
      route("/notes", () => import("./routes/notes.tsx"), { id: "notes", render: "ssr" }),
      route("/agent-tools", () => import("./routes/agent-tools.tsx"), {
        id: "agent-tools",
        render: "ssr",
        hydration: "islands",
      }),
      route("/products/:productId", () => import("./routes/product.tsx"), {
        id: "product",
        markdown: true,
        middleware: ["productMarkdown"],
        render: "ssg",
        speculation: "prerender",
      }),
      route("/pricing", () => import("./routes/pricing.tsx"), {
        id: "pricing",
        render: "isg",
        // Two policies on one route: the time window keeps the page fresh on
        // its own, and the webhook policy lets an upstream change push an
        // immediate refresh through `POST /__pracht/revalidate` (authenticated
        // with PRACHT_REVALIDATE_TOKEN). Without `webhookRevalidate()` that
        // endpoint reports the path as `skipped`.
        revalidate: [timeRevalidate(3600), webhookRevalidate()],
        speculation: "prefetch",
      }),
      route("/gallery", () => import("./routes/gallery.tsx"), {
        id: "gallery",
        render: "ssr",
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
