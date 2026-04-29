---
title: The Killer Pracht Demo
lead: A product + agent demo that plays directly into pracht's strengths: explicit app graphs, per-route rendering, server-only loaders, Markdown negotiation, and deploy-anywhere adapters.
breadcrumb: Demo Comparison
prev:
  href: /docs/why-pracht
  title: Why Pracht?
next:
  href: /docs/routing
  title: Routing
---

## The positioning

Pracht should not be demoed as "another meta-framework." Demo it as **the full-stack Preact framework with an app graph humans and agents can understand**.

The strongest parts of pracht are unusually demo-friendly:

| Strength | Why it is compelling |
| --- | --- |
| **Preact-first** | Small runtime, familiar JSX/hooks, fast hydration, less JavaScript by default. |
| **Explicit route manifest** | The app graph is visible in one file: URL, component, shell, middleware, render mode, route ID. |
| **Per-route rendering** | A real product can mix SSG, SSR, ISG, and SPA without splitting apps or reshaping folders. |
| **Server-owned data loading** | Loaders stay server-side across SSR, SSG, ISG, SPA route-state requests, and client navigation. |
| **Named shells and middleware** | Layout and auth policy are reusable app concepts, not hidden folder conventions. |
| **Vite-native** | Fast dev loop, normal Vite plugins, multi-environment builds. |
| **Deploy-anywhere adapters** | The same app targets Node, Cloudflare Workers, and Vercel through thin adapters. |
| **Agent-readable content** | Routes can serve HTML to browsers and Markdown to tools from the same canonical URL. |
| **Inspectable CLI** | `pracht inspect ... --json`, `pracht verify`, and `pracht doctor` make the framework automation-friendly. |

That gives us a sharper story than "here is a blog." The demo should show a realistic app, then show an agent successfully modifying it because pracht made the important facts explicit.

---

## The demo app: Launchpad

Launchpad is a fictional product management SaaS. It has the surfaces every real app has: marketing, blog, pricing, authenticated dashboard, project pages, settings, API routes, and now an agent briefing page.

| Route | Mode | Product reason | Pracht strength |
| --- | --- | --- | --- |
| `/` | **SSG** | Landing page should be instant and CDN-cheap. | Static generation is one route option, not a separate site. |
| `/blog/:slug` | **SSG** | SEO content is generated with `getStaticPaths()`. | Dynamic static routes stay explicit. |
| `/pricing` | **ISG** | Pricing is fast like static but can revalidate hourly. | Freshness policy lives next to the route. |
| `/agents` | **SSG + Markdown** | Humans see a polished briefing; agents can request source Markdown. | One canonical URL, two representations. |
| `/app` | **SSR + auth** | Personalized dashboard needs request-time data. | Middleware and server loaders are visible. |
| `/app/projects/:projectId` | **SSR + auth** | Project detail needs fresh, protected data. | Dynamic params and auth are obvious. |
| `/app/settings` | **SPA + auth shell** | Interactive settings do not need SEO. | Shell paints immediately; route UI is client-only. |

## The reveal: one file explains the whole product

```ts [examples/showcase/src/routes.ts]
import { defineApp, group, route, timeRevalidate } from "@pracht/core";

export const app = defineApp({
  shells: {
    marketing: () => import("./shells/marketing.tsx"),
    app: () => import("./shells/app.tsx"),
  },
  middleware: {
    auth: () => import("./middleware/auth.ts"),
  },
  routes: [
    group({ shell: "marketing" }, [
      route("/", () => import("./routes/home.tsx"), { render: "ssg" }),
      route("/blog/:slug", () => import("./routes/blog-post.tsx"), { render: "ssg" }),
      route("/pricing", () => import("./routes/pricing.tsx"), {
        render: "isg",
        revalidate: timeRevalidate(3600),
      }),
      route("/agents", () => import("./routes/agents.tsx"), { render: "ssg" }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/app", () => import("./routes/dashboard.tsx"), { render: "ssr" }),
      route("/app/projects/:projectId", () => import("./routes/project.tsx"), { render: "ssr" }),
      route("/app/settings", () => import("./routes/settings.tsx"), { render: "spa" }),
    ]),
  ],
});
```

In most frameworks, a reviewer or an AI agent has to infer behavior from folders, route segment conventions, config files, and special exports. In pracht, the app graph is a source artifact.

That is the hook.

---

## The agent angle: Pracht is easy to operate on

Agents are good when the system exposes structure. Pracht exposes structure in ways that are useful:

1. **The manifest is a planning surface.** An agent can answer "which routes are authenticated?" or "which pages are static?" by reading `src/routes.ts`.
2. **Render modes are safe edits.** Changing a route from SSR to ISG is a small config edit plus any required revalidation policy.
3. **Server code has a known home.** Loaders are the place for data access; route components receive typed data.
4. **Markdown negotiation removes scraping.** A route can export `markdown`, and agents can ask the same URL for `Accept: text/markdown`.
5. **CLI output can be machine-readable.** `pracht inspect routes --json` gives tools a stable app graph.

The new showcase route `/agents` demonstrates this directly. It renders a polished browser page, but the same route exports an agent briefing:

```sh
# Human version
curl https://showcase.example/agents

# Agent version
curl -H "Accept: text/markdown" https://showcase.example/agents
```

```tsx [examples/showcase/src/routes/agents.tsx]
export const markdown = `# Launchpad Agent Briefing

## Why Pracht works well with agents

- The route manifest is explicit.
- Render modes are strings agents can inspect and change safely.
- Loaders stay server-side.
- Markdown content negotiation avoids scraping.
- CLI inspection commands expose the app graph as JSON.
`;
```

## The live demo script

### 1. Start with the product, not the framework

Open Launchpad. Show that it looks like a normal SaaS site, not a framework toy.

```sh
cd examples/showcase
pnpm pracht dev
```

Then click through:

- `/` — SSG marketing.
- `/blog/why-pracht` — SSG dynamic content.
- `/pricing` — ISG with hourly revalidation.
- `/agents` — SSG human page with Markdown content negotiation.
- Sign in — SSR authenticated app.
- `/app/settings` — SPA inside the same protected app shell.

### 2. Show the manifest

Open `examples/showcase/src/routes.ts` and say:

> Everything we just saw is represented here. Not hidden in folder names. Not scattered across route conventions. The app graph is explicit.

### 3. Give an agent a real task

Use a task that would be annoying in a convention-heavy framework:

> Add a public `/security` page. It should use the marketing shell, be SSG, export Markdown for agents, and link from the header. Then run the framework checks.

The reason this demo works: the agent can copy the `/agents` pattern, add one route to the manifest, and verify it. The route behavior is not implicit.

### 4. Ask the agent to explain the app

Prompt:

> Inspect the Launchpad route manifest and tell me which routes are static, which are personalized, which are auth-protected, and which can be served to agents as Markdown.

Expected answer should be precise because the information is in one place.

### 5. Ask the agent to tune performance

Prompt:

> Pricing currently changes daily. Confirm whether its render mode is appropriate, and adjust the revalidation window to 24 hours.

Expected patch: `timeRevalidate(86400)` on `/pricing`, not a folder migration.

---

## Comparison: what the demo makes obvious

| Question | Convention-heavy answer | Pracht answer |
| --- | --- | --- |
| "What renders at build time?" | Inspect files, exports, route segment config, build settings. | Read `render: "ssg"` and `render: "isg"` in the manifest. |
| "What is behind auth?" | Follow nested layouts, middleware files, or loader redirects. | Read `group({ middleware: ["auth"] })`. |
| "Can this page become static?" | Maybe; depends on framework rules and nearby files. | Change the route mode if the loader supports it. |
| "Can an agent consume this page?" | Usually scrape HTML or rely on external docs. | Request Markdown from the same URL when the route exports `markdown`. |
| "Can we deploy somewhere else?" | Depends on framework/platform coupling. | Swap adapters; app code stays portable. |

## The blog thesis

A compelling blog post can be framed like this:

> Modern apps are not one rendering strategy. They are a graph of surfaces with different freshness, privacy, SEO, and interactivity needs. Pracht makes that graph explicit — for humans, for code review, and for agents.

Suggested title options:

- **Pracht: the Preact framework with an app graph agents can read**
- **Stop hiding your rendering strategy in folders**
- **One Preact app, four render modes, zero guessing**
- **The full-stack framework that makes AI code changes boring**

## Why this should compel people

The demo is exciting because it connects three current needs:

1. **Performance:** Preact-first and per-route rendering keep JavaScript and server work low.
2. **Clarity:** Explicit routing makes architecture review easy.
3. **Automation:** Agents can inspect, explain, and safely modify the app because the important facts are structured.

That is a differentiated story. Pracht is not just smaller. It is more legible.
