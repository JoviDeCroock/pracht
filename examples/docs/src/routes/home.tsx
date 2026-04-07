import type { RouteComponentProps } from "viact";
import { CodeBlock } from "../components/CodeBlock";

export async function loader() {
  return { version: "0.1.0" };
}

export function head() {
  return { title: "viact — Preact-first. Vite-native. Explicit routing." };
}

const FEATURES = [
  {
    icon: "🗺",
    title: "Explicit Route Manifest",
    desc: "Define routes in code, not filesystem conventions. Assign shells, middleware, and render modes per group or route — auditable and type-checked.",
  },
  {
    icon: "⚡",
    title: "Per-Route Render Modes",
    desc: "SSG, SSR, ISG, and SPA — pick the right strategy for each page. Mix static marketing pages with dynamic dashboards in a single app.",
  },
  {
    icon: "🔷",
    title: "Preact-First",
    desc: "Built on Preact for a tiny runtime. Full hooks support, JSX, and the complete Preact ecosystem. Fast by default.",
  },
  {
    icon: "🌐",
    title: "Edge-Ready Adapters",
    desc: "Deploy to Cloudflare Workers, Vercel Edge Functions, or Node.js. Thin adapter layers with no vendor lock-in.",
  },
  {
    icon: "⚙️",
    title: "Vite-Native",
    desc: "Full Vite pipeline for client and SSR builds. Bring your own plugins — Tailwind, MDX, image tools all work without special integration.",
  },
  {
    icon: "🔒",
    title: "End-to-End Types",
    desc: "Loader return types flow automatically to components. No manual typing, no casting — just inference from server to client.",
  },
];

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

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <div>
      {/* ─── Hero ─────────────────────────────────────────────── */}
      <section class="hero">
        <div class="hero-bg" />
        <div class="hero-grid" />
        <div class="hero-inner">
          <div class="hero-badge">
            <span class="badge">
              <span class="badge-dot" />v{data.version} · Cloudflare-ready
            </span>
          </div>

          <h1 class="hero-title">
            Build with Preact.
            <br />
            <span class="gradient-text">Deploy everywhere.</span>
          </h1>

          <p class="hero-sub">
            <strong>viact</strong> is a Preact framework with <strong>explicit routing</strong>,
            per-route render modes, and thin adapters for Cloudflare, Vercel, and Node.js.
          </p>

          <div class="hero-actions">
            <a href="/docs/routing" class="btn btn-primary">
              Read the docs →
            </a>
            <a href="/docs/adapters" class="btn btn-secondary">
              View Adapters
            </a>
          </div>

          <div class="hero-code">
            <p class="hero-code-label">src/routes.ts</p>
            <CodeBlock
              filename="routes.ts"
              code={`import { defineApp, group, route, timeRevalidate } from "viact";

export const app = defineApp({
  shells: {
    public: "./shells/public.tsx",
    app:    "./shells/app.tsx",
  },
  middleware: { auth: "./middleware/auth.ts" },
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

      {/* ─── Features ─────────────────────────────────────────── */}
      <section class="section">
        <div class="section-inner">
          <p class="section-eyebrow">Why viact</p>
          <h2 class="section-title">Everything you need, nothing you don't</h2>
          <p class="section-sub">
            A focused framework that gives you the primitives to build fast, maintainable Preact
            applications — without magic.
          </p>
          <div class="features-grid">
            {FEATURES.map((f) => (
              <div key={f.title} class="feature-card">
                <div class="feature-icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
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
        <div
          class="section-inner"
          style="display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center;"
        >
          <div>
            <p class="section-eyebrow">Data Loading</p>
            <h2 class="section-title" style="margin-bottom:16px;">
              Loaders stay on the server
            </h2>
            <p style="color:var(--text-3);line-height:1.75;margin-bottom:16px;">
              Loader functions run server-side only — during the build for SSG, on each request for
              SSR. Secrets, database connections, and API keys never reach the client bundle.
            </p>
            <p style="color:var(--text-3);line-height:1.75;margin-bottom:24px;">
              After hydration, client navigation fetches only the loader data as JSON — the
              component tree updates without a full page reload.
            </p>
            <a href="/docs/data-loading" class="btn btn-secondary" style="display:inline-flex;">
              Data loading guide →
            </a>
          </div>
          <div>
            <CodeBlock
              filename="routes/dashboard.tsx"
              code={`import type { LoaderArgs, RouteComponentProps } from "viact";

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
            Install viact and the Vite plugin, wire up your adapter, and ship to Cloudflare Workers
            or Vercel in minutes.
          </p>
          <div class="install-block">
            <span class="install-prompt">$</span>
            <span>npm create viact@latest my-app</span>
          </div>
          <div class="docs-links">
            {[
              {
                href: "/docs/routing",
                icon: "🗺",
                title: "Routing",
                sub: "Manifest API, groups, paths",
              },
              {
                href: "/docs/rendering",
                icon: "⚡",
                title: "Rendering",
                sub: "SSG, SSR, ISG, SPA",
              },
              {
                href: "/docs/data-loading",
                icon: "📡",
                title: "Data Loading",
                sub: "Loaders, actions, hooks",
              },
              {
                href: "/docs/adapters",
                icon: "🌐",
                title: "Adapters",
                sub: "Cloudflare, Vercel, Node",
              },
            ].map((l) => (
              <a key={l.href} href={l.href} class="doc-link-card">
                <span style="font-size:20px;">{l.icon}</span>
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
