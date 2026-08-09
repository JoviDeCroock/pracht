import {
  defineApp,
  forbidRenderMode,
  group,
  requireHead,
  requireMiddleware,
  requireShell,
  route,
} from "@pracht/core";

export const app = defineApp({
  shells: {
    marketing: () => import("./shells/marketing.tsx"),
    app: () => import("./shells/app.tsx"),
  },
  middleware: {
    auth: () => import("./middleware/auth.ts"),
    rateLimit: () => import("./middleware/rate-limit.ts"),
  },

  // ── The capability graph ────────────────────────────────────────────────
  // Six operations, registered as explicitly as shells and middleware. No
  // loader and no API route is ever inferred as an agent tool; what is here is
  // what agents can reach, and `pracht inspect capabilities` prints exactly
  // this list with its schemas, effects, and exposures.
  capabilities: {
    "projects.search": () => import("./capabilities/projects-search.ts"),
    "projects.create": () => import("./capabilities/projects-create.ts"),
    "projects.deploy": () => import("./capabilities/projects-deploy.ts"),
    "projects.archive": () => import("./capabilities/projects-archive.ts"),
    "agent.whoami": () => import("./capabilities/agent-whoami.ts"),
    "agent.brief": () => import("./capabilities/agent-brief.ts"),
  },

  // ── The trust layer ─────────────────────────────────────────────────────
  agents: {
    webBotAuth: {
      // "observe" identifies signed agents and serves everybody; `agent.brief`
      // opts itself up to "require". The key below is *public* — it is the
      // demo agent in scripts/agent.mjs, whose private half is derived from a
      // seed constant in that script. Committing it is safe and deliberate.
      policy: "observe",
      keys: [{ x: "Z9G_yWTMVrKrgm2PLrAXxDgGmRVEuft7oHn4dNh_ku8", agent: "demo-agent.launchpad" }],
    },
    confirmation: {
      // A destructive call is not authorised by the caller holding a token —
      // a person decides, at /app/approvals. Requires the approval store and
      // principal resolver registered in src/server/agent-runtime.ts.
      mode: "human",
      ttlSeconds: 900,
    },
  },

  // ── Invariants `pracht verify` enforces ─────────────────────────────────
  // Reviewed once by a human; from then on no author, human or agent, can
  // merge a violation.
  constraints: [
    requireMiddleware("/app/**", "auth"),
    requireShell("/app/**", "app"),
    forbidRenderMode("/app/**", "ssg", "isg"),
    requireHead("**"),
  ],

  routes: [
    // Public marketing — static, CDN-fast, great SEO
    group({ shell: "marketing" }, [
      route("/", () => import("./routes/home.tsx"), {
        id: "home",
        render: "ssg",
      }),
      route("/agents", () => import("./routes/agents.tsx"), {
        id: "agents",
        render: "ssg",
      }),
      // The interactive console needs the live capability graph, so it renders
      // per request.
      route("/playground", () => import("./routes/playground.tsx"), {
        id: "playground",
        render: "ssr",
      }),
      route("/blog/:slug", () => import("./routes/blog-post.tsx"), {
        id: "blog-post",
        render: "ssg",
      }),
      // Plans are hard-coded in this demo, so there is nothing to revalidate:
      // SSG keeps the whole marketing shell on the CDN with no function
      // invocation. examples/basic covers the ISG build path.
      route("/pricing", () => import("./routes/pricing.tsx"), {
        id: "pricing",
        render: "ssg",
      }),
    ]),

    // Authenticated app — personalized, interactive
    group({ shell: "app", middleware: ["auth"] }, [
      route("/app", () => import("./routes/dashboard.tsx"), {
        id: "dashboard",
        render: "ssr",
      }),
      route("/app/projects/:projectId", () => import("./routes/project.tsx"), {
        id: "project",
        render: "ssr",
      }),
      route("/app/approvals", () => import("./routes/approvals.tsx"), {
        id: "approvals",
        render: "ssr",
      }),
      route("/app/audit", () => import("./routes/audit.tsx"), {
        id: "audit",
        render: "ssr",
      }),

      // Settings is pure client UI — no SEO, no server rendering needed
      route("/app/settings", () => import("./routes/settings.tsx"), {
        id: "settings",
        render: "spa",
      }),
    ]),
  ],
});
