import type { RouteComponentProps } from "@pracht/core";
import type { Icon } from "@tabler/icons-preact";
import {
  IconSitemap,
  IconBolt,
  IconAtom,
  IconWorld,
  IconWorldBolt,
  IconSettings,
  IconLock,
  IconArrowRight,
  IconServerBolt,
  IconPlug,
} from "@tabler/icons-preact";
import { CodeBlock } from "../components/CodeBlock";
import { inter } from "../fonts";

export async function loader() {
  return { version: "0.1.0" };
}

const AGENT_DOC_LINKS: { href: string; text: string }[] = [
  {
    href: "/docs/getting-started",
    text: "Getting started — project creation, dev server, and first production build",
  },
  {
    href: "/docs/why-pracht",
    text: "Why pracht — how it compares to other full-stack frameworks and when it fits",
  },
  {
    href: "/docs/routing",
    text: "Routing — explicit src/routes.ts manifest wiring shells, middleware, and render modes per route",
  },
  {
    href: "/docs/rendering",
    text: "Rendering modes — per-route SSG, SSR, ISG, and SPA in a single app",
  },
  {
    href: "/docs/data-loading",
    text: "Data loading — server-only loaders, mutations via API routes, and end-to-end type inference",
  },
  {
    href: "/docs/api-routes",
    text: "API routes — standalone server endpoints returning native Response objects",
  },
  {
    href: "/docs/middleware",
    text: "Middleware — server interceptors for auth, redirects, validation, and context enrichment",
  },
  {
    href: "/docs/shells",
    text: "Shells — layout wrappers decoupled from URL structure, attached per route or group",
  },
  {
    href: "/docs/styling",
    text: "Styling — build-time CSS via CSS Modules, Tailwind, or plain stylesheets",
  },
  {
    href: "/docs/prefetching",
    text: "Prefetching — automatic data prefetching for instant navigation, configurable per route",
  },
  {
    href: "/docs/performance",
    text: "Performance — what pracht costs a page per hydration mode, how those numbers are measured, and the automatic code splitting, module preloading, and vendor chunking",
  },
  {
    href: "/docs/cli",
    text: "CLI — @pracht/cli dev, build, scaffold, and doctor commands",
  },
  {
    href: "/docs/deployment",
    text: "Deployment — building and shipping via platform adapters, including runtime ISG on Node",
  },
  {
    href: "/docs/adapters",
    text: "Adapters — Cloudflare Workers, Vercel Edge Functions, and Node.js",
  },
  {
    href: "/docs/agents",
    text: "The agentic web — the one app graph pracht projects to browsers and to agents, plus Accept: text/markdown negotiation and /llms.txt discovery",
  },
  {
    href: "/docs/capabilities",
    text: "Capabilities — typed operations defined once and projected to server calls, HTTP endpoints, WebMCP page tools, and remote MCP tools",
  },
  {
    href: "/docs/agent-trust",
    text: "Agent trust — Web Bot Auth verified identity, confirmation flow for destructive operations, audit events, and pracht eval",
  },
  {
    href: "/docs/coding-agents",
    text: "Coding agents — the pracht dev-mcp authoring server, Claude Code skills, constraints, app-graph snapshots, and pracht plan/report",
  },
  {
    href: "/docs/demo-comparison",
    text: "Demo comparison — product + agent demo highlighting pracht's strengths",
  },
  {
    href: "/docs/recipes/auth",
    text: "Recipe: authentication — session-based auth with middleware and route guards",
  },
  {
    href: "/docs/recipes/forms",
    text: "Recipe: forms — progressive-enhancement <Form> backed by API routes",
  },
  {
    href: "/docs/recipes/i18n",
    text: "Recipe: i18n — locale detection middleware and translated loader content",
  },
  {
    href: "/docs/recipes/csp",
    text: "Recipe: CSP — focused Content Security Policy via route or shell headers",
  },
  {
    href: "/docs/recipes/testing",
    text: "Recipe: testing — Vitest for loaders and API routes, Playwright for E2E, and capability/agent-surface testing with pracht eval",
  },
  {
    href: "/docs/recipes/fullstack-cloudflare",
    text: "Recipe: full-stack Cloudflare — D1, KV, and R2 wired into loaders and API routes",
  },
  {
    href: "/docs/recipes/fullstack-vercel",
    text: "Recipe: full-stack Vercel — Postgres (Neon), KV (Upstash), and Blob storage",
  },
  {
    href: "/docs/migrate/nextjs",
    text: "Migrate from Next.js — App Router to pracht with side-by-side examples",
  },
];

export const markdown = [
  "# Agent guidance",
  "",
  "Doing fetches with `Accept: text/markdown` to the following URLs will provide you with documentation:",
  "",
  ...AGENT_DOC_LINKS.map((l) => `- [${l.text}](${l.href})`),
  "",
].join("\n");

export function head() {
  // The shell registers `inter` too — the head renderer collapses the
  // duplicate to a single preload and @font-face block.
  return { title: "pracht — one app graph, projected to browsers and to agents.", fonts: [inter] };
}

export function headers() {
  // RFC 8288 Link headers for agent discovery.
  return {
    link: [
      '</.well-known/agent-skills/index.json>; rel="agent-skills"',
      '</sitemap.xml>; rel="sitemap"; type="application/xml"',
      '</docs/getting-started>; rel="service-doc"',
    ].join(", "),
  };
}

const FEATURES: { Icon: Icon; title: string; desc: string }[] = [
  {
    Icon: IconSitemap,
    title: "One Explicit App Graph",
    desc: "Routes, loaders, API routes, and capabilities are declared in one typed manifest and resolved into a single graph. Nothing is inferred from folder names, so what runs where is readable by you, by a reviewer, and by a machine.",
  },
  {
    Icon: IconWorldBolt,
    title: "Projected to Agents, Not Scraped",
    desc: "The same graph becomes typed HTTP endpoints, WebMCP page tools, remote MCP tools, and an llms.txt index. Agents call declared operations with validated input instead of guessing at your DOM.",
  },
  {
    Icon: IconLock,
    title: "One Set of Rules per Operation",
    desc: "Validation, middleware, effect class, and confirmation run on the server for every caller — your loader, the browser, an in-page agent, a remote MCP host. The human UI and the agent surface cannot drift, because they are the same function.",
  },
  {
    Icon: IconAtom,
    title: "Preact-First",
    desc: "Full hooks, JSX, and the Preact ecosystem on a runtime you can size: 0 KB on a static route, 17.4 KB gzip fully hydrated. Both measured by pnpm bench, both gated in CI.",
  },
  {
    Icon: IconBolt,
    title: "Per-Route Render and Hydration Modes",
    desc: "SSG, SSR, ISG, or SPA, and full, islands, or no hydration — chosen per route. Mix static marketing pages with dynamic dashboards in one app and one build.",
  },
  {
    Icon: IconSettings,
    title: "Vite-Native, End-to-End Typed",
    desc: "Full Vite pipeline for client and SSR builds, plus loader return types that flow into components and capability contracts that flow into every call site.",
  },
];

/**
 * Gzipped client JavaScript a cold page load fetches, per hydration mode.
 *
 * These are the `coldGzipBytes` figures recorded in `bench/baseline.json` and
 * re-measured by `pnpm bench`. Update both together — CI fails the bundle-size
 * job when the harness and its baseline disagree, but nothing checks that this
 * page agrees with either.
 */
const LADDER: { mode: string; kb: string; bytes: number; desc: string }[] = [
  {
    mode: 'hydration: "none"',
    kb: "0 KB",
    bytes: 0,
    desc: "Static HTML. No client runtime is injected at all.",
  },
  {
    mode: 'hydration: "islands"',
    kb: "7.5 KB",
    bytes: 7540,
    desc: "Preact plus the island bootstrap. Only components in src/islands/ hydrate — the router never loads.",
  },
  {
    mode: 'hydration: "full"',
    kb: "17.4 KB",
    bytes: 16564,
    desc: "The page hydrates and the client router takes over navigation, prefetching, and loader fetches.",
  },
  {
    mode: "full + preact/compat",
    kb: "18.2 KB",
    bytes: 18114,
    desc: "The same page with the React compatibility layer, so React-authored dependencies resolve.",
  },
];

const LADDER_MAX_BYTES = Math.max(...LADDER.map((rung) => rung.bytes));

const MODES = [
  {
    tag: "ssg",
    label: "SSG",
    title: "Static Generation",
    desc: "HTML at build time. Serve from CDN with zero server cost. Perfect for marketing pages, blogs, and docs.",
  },
  {
    tag: "ssr",
    label: "SSR",
    title: "Server Rendering",
    desc: "Fresh HTML on every request. Full access to cookies, headers, and auth state. Ideal for personalized pages.",
  },
  {
    tag: "isg",
    label: "ISG",
    title: "Incremental Static",
    desc: "Static HTML that regenerates on a schedule. Serve instantly, update in the background. Great for catalogs and pricing.",
  },
  {
    tag: "spa",
    label: "SPA",
    title: "Client-Only",
    desc: "No SSR — render entirely in the browser. Best for auth-gated dashboards where SEO doesn't matter.",
  },
];

const GET_STARTED_LINKS: { href: string; Icon: Icon; title: string; sub: string }[] = [
  {
    href: "/docs/routing",
    Icon: IconSitemap,
    title: "Routing",
    sub: "Manifest API, groups, paths",
  },
  {
    href: "/docs/rendering",
    Icon: IconBolt,
    title: "Rendering",
    sub: "SSG, SSR, ISG, SPA",
  },
  {
    href: "/docs/data-loading",
    Icon: IconServerBolt,
    title: "Data Loading",
    sub: "Loaders, actions, hooks",
  },
  {
    href: "/docs/adapters",
    Icon: IconPlug,
    title: "Adapters",
    sub: "Cloudflare, Netlify, Vercel, Node",
  },
];

export function Component(_props: RouteComponentProps<typeof loader>) {
  return (
    <div>
      {/* ─── Hero ─────────────────────────────────────────────── */}
      <section class="hero">
        <div class="hero-bg" />
        <div class="hero-grid" />
        <div class="hero-inner">
          <h1 class="hero-title">
            One app graph.
            <br />
            <span class="gradient-text">Two kinds of caller.</span>
          </h1>

          <p class="hero-sub">
            <strong>pracht</strong> resolves your routes, loaders, API routes, and{" "}
            <strong>capabilities</strong> into one explicit graph — then projects it to browsers{" "}
            <em>and</em> to agents: HTTP endpoints, WebMCP page tools, remote MCP, and{" "}
            <code>llms.txt</code>. Most frameworks render your app for humans and leave agents to
            scrape it.
          </p>

          <div class="hero-actions">
            <a href="/docs/getting-started" class="btn btn-primary">
              Read the docs
              <IconArrowRight size={14} stroke={2} />
            </a>
            <a href="/docs/agents" class="btn btn-secondary">
              See the agent projections
            </a>
          </div>

          <div class="hero-code">
            <p class="hero-code-label">src/routes.ts</p>
            <CodeBlock
              filename="routes.ts"
              code={`import { defineApp, group, route, timeRevalidate } from "@pracht/core";

export const app = defineApp({
  shells: {
    public: "./shells/public.tsx",
    app:    "./shells/app.tsx",
  },
  middleware: { auth: "./middleware/auth.ts" },
  // The same graph an agent sees: typed operations, not a scraped DOM.
  capabilities: { "notes.search": "./capabilities/notes-search.ts" },
  routes: [
    group({ shell: "public" }, [
      route("/",        "./routes/home.tsx",    { render: "ssg" }),
      route("/pricing", "./routes/pricing.tsx", {
        render: "isg", revalidate: timeRevalidate(3600),
      }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
      route("/settings",  "./routes/settings.tsx",  { render: "spa" }),
    ]),
  ],
});`}
            />
          </div>
        </div>
      </section>

      {/* ─── The numbers ──────────────────────────────────────── */}
      <section class="section ladder-section">
        <div class="section-inner">
          <p class="section-eyebrow">Measured, not claimed</p>
          <h2 class="section-title">What a page costs</h2>
          <p class="section-sub">
            Hydration is a per-route setting, so the framework's cost is something you choose rather
            than something you inherit. Each rung below is the same page, rendering the same markup,
            with one thing changed.
          </p>
          <div class="ladder">
            {LADDER.map((rung) => (
              <div key={rung.mode} class="ladder-row">
                <code class="ladder-mode">{rung.mode}</code>
                <div class="ladder-bar-track">
                  <div
                    class="ladder-bar"
                    style={`width:${Math.round((rung.bytes / LADDER_MAX_BYTES) * 100)}%`}
                  />
                </div>
                <span class="ladder-kb">{rung.kb}</span>
                <p class="ladder-desc">{rung.desc}</p>
              </div>
            ))}
          </div>
          <p class="ladder-note">
            Gzipped client JavaScript a cold load fetches, including the chunks the router imports
            after hydration. Your application code sits on top of this. Switching prefetching off
            with <code>client: {"{ prefetch: false }"}</code> takes full hydration to 15.9 KB.
            Re-measure any of it with <code>pnpm bench</code> —{" "}
            <a href="/docs/performance">how these numbers are produced</a>.
          </p>
        </div>
      </section>

      {/* ─── Features ─────────────────────────────────────────── */}
      <section class="section">
        <div class="section-inner">
          <p class="section-eyebrow">Why pracht</p>
          <h2 class="section-title">Write the app down once</h2>
          <p class="section-sub">
            Everything below follows from the graph being explicit. A manifest a machine can read is
            a manifest a machine can serve, review, and test.
          </p>
          <div class="features-grid">
            {FEATURES.map((f) => (
              <div key={f.title} class="feature-card">
                <div class="feature-icon">
                  <f.Icon size={18} stroke={1.5} />
                </div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
          <p class="ladder-note">
            <IconWorld size={14} stroke={1.5} /> And it deploys anywhere: Node, Cloudflare Workers,
            Netlify, Vercel, or a pure static export, from one codebase and one build. A thin{" "}
            <a href="/docs/adapters">adapter</a>, not a rewrite.
          </p>
        </div>
      </section>

      {/* ─── Render Modes ──────────────────────────────────────── */}
      <section class="section modes-section">
        <div class="section-inner">
          <p class="section-eyebrow">Rendering</p>
          <h2 class="section-title">One app, four rendering strategies</h2>
          <p class="section-sub">
            Configure render mode per route. Mix and match in the same app without extra wiring or
            separate deployments.
          </p>
          <div class="modes-grid">
            {MODES.map((m) => (
              <div key={m.tag} class="mode-card">
                <span class={`mode-tag ${m.tag}`}>{m.label}</span>
                <h3>{m.title}</h3>
                <p>{m.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── How it works ──────────────────────────────────────── */}
      <section class="section">
        <div class="section-inner data-loading-section">
          <div>
            <p class="section-eyebrow">Data Loading</p>
            <h2 class="section-title data-loading-title">Loaders stay on the server</h2>
            <p class="data-loading-copy">
              Loader functions run server-side only — during the build for SSG, on each request for
              SSR. Secrets, database connections, and API keys never reach the client bundle.
            </p>
            <p class="data-loading-copy data-loading-copy-last">
              After hydration, client navigation fetches only the loader data as JSON — the
              component tree updates without a full page reload.
            </p>
            <a href="/docs/data-loading" class="btn btn-secondary data-loading-link">
              Data loading guide
              <IconArrowRight size={14} stroke={2} />
            </a>
          </div>
          <div class="data-loading-code">
            <CodeBlock
              filename="routes/dashboard.tsx"
              code={`import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

export async function loader({ request, context }: LoaderArgs) {
  const user = await getUser(request);
  return { user, projects: await context.db.projects.all() };
}

export function head({ data }) {
  return { title: \`\${data.user.name} — Dashboard\` };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  // data is typed: { user: User; projects: Project[] }
  return <h1>Welcome, {data.user.name}</h1>;
}`}
            />
          </div>
        </div>
      </section>

      {/* ─── Get Started ───────────────────────────────────────── */}
      <section
        class="section getstarted-section"
        style="background:var(--bg-2);border-top:1px solid var(--border-l);border-bottom:1px solid var(--border-l);"
      >
        <div class="section-inner" style="text-align:center;">
          <p class="section-eyebrow">Get Started</p>
          <h2 class="section-title">Ready to build?</h2>
          <p class="section-sub" style="margin:0 auto;">
            Install pracht and the Vite plugin, wire up your adapter, and ship to Cloudflare Workers
            or Vercel in minutes.
          </p>
          <div class="install-block">
            <span class="install-prompt">$</span>
            <span>npm create pracht@latest my-app</span>
          </div>
          <div class="docs-links">
            {GET_STARTED_LINKS.map((l) => (
              <a key={l.href} href={l.href} class="doc-link-card">
                <span class="dlc-icon">
                  <l.Icon size={16} stroke={1.5} />
                </span>
                <span class="dlc-title">{l.title}</span>
                <span class="dlc-sub">{l.sub}</span>
              </a>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
