const LINKS: { href: string; text: string }[] = [
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
    text: "Performance — automatic code splitting, module preloading, and vendor chunking",
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
    href: "/docs/llms",
    text: "LLM content negotiation — markdown on the same URLs as HTML, plus /llms.txt",
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
    text: "Recipe: testing — Vitest for loaders and API routes, Playwright for E2E",
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

const INTRO =
  "Doing fetches with `Accept: text/markdown` to the following URLs will provide you with documentation:";

export const markdown = [
  "# Agent guidance",
  "",
  INTRO,
  "",
  ...LINKS.map((l) => `- [${l.text}](${l.href})`),
  "",
].join("\n");

export function head() {
  return { title: "pracht — Agent guidance" };
}

export function headers() {
  return {
    link: [
      '</.well-known/agent-skills/index.json>; rel="agent-skills"',
      '</llms.txt>; rel="alternate"; type="text/plain"',
      '</sitemap.xml>; rel="sitemap"; type="application/xml"',
      '</docs/getting-started>; rel="service-doc"',
    ].join(", "),
  };
}

export function Component() {
  return (
    <div class="doc-page">
      <h1 class="doc-title">Agent guidance</h1>
      <p class="doc-lead">
        Doing fetches with <code>Accept: text/markdown</code> to the following URLs will provide you
        with documentation:
      </p>
      <ul>
        {LINKS.map((l) => (
          <li key={l.href}>
            <a href={l.href}>{l.text}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}
