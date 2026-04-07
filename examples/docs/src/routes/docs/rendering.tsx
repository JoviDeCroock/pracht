import { CodeBlock } from "../../components/CodeBlock";

export function head() {
  return { title: "Rendering Modes — viact docs" };
}

export function Component() {
  return (
    <div class="doc-page">
      <div class="breadcrumb">
        <a href="/">viact</a>
        <span class="breadcrumb-sep">/</span>
        <a href="/docs/routing">Docs</a>
        <span class="breadcrumb-sep">/</span>
        <span>Rendering Modes</span>
      </div>

      <h1 class="doc-title">Rendering Modes</h1>
      <p class="doc-lead">
        viact supports four rendering modes configured per route. Each route
        declares how and when its HTML is generated — giving you the right
        performance and freshness trade-off for every page in one app.
      </p>

      <h2>Overview</h2>
      <div class="doc-table-wrap">
        <table class="doc-table">
          <thead>
            <tr>
              <th>Mode</th>
              <th>HTML generated</th>
              <th>Loader runs</th>
              <th>Best for</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>SSG</td><td>Build time</td><td>Build time</td><td>Marketing pages, docs, blogs</td></tr>
            <tr><td>SSR</td><td>Every request</td><td>Every request</td><td>Personalized, dynamic pages</td></tr>
            <tr><td>ISG</td><td>Build + revalidation</td><td>Build + on stale</td><td>Pricing, catalogs, semi-static</td></tr>
            <tr><td>SPA</td><td>Client only</td><td>Client navigation</td><td>Auth-gated dashboards, admin UI</td></tr>
          </tbody>
        </table>
      </div>

      <div class="doc-sep" />

      <h2>SSG — Static Site Generation</h2>
      <CodeBlock code={`route("/about", () => import("./routes/about.tsx"), { render: "ssg" })`} />
      <p>
        HTML is generated at build time. The loader runs once during the build,
        and the output is written to <code>dist/client/about/index.html</code>.
        No server required for this route — it's served as a static file from
        your CDN.
      </p>

      <h3>Dynamic SSG paths</h3>
      <p>
        For routes with dynamic segments, export a <code>prerender</code>{" "}
        function to enumerate all paths:
      </p>
      <CodeBlock
        filename="src/routes/blog-post.tsx"
        code={`export async function prerender(): Promise<string[]> {
  const posts = await getAllPosts();
  return posts.map(p => \`/blog/\${p.slug}\`);
}

export async function loader({ params }: LoaderArgs) {
  return { post: await getPost(params.slug) };
}

export function Component({ data }) {
  return <article>{data.post.title}</article>;
}`}
      />
      <p>
        The build calls <code>prerender()</code> to enumerate all paths, then
        runs the loader and renderer for each. Prerendering runs concurrently
        (default: 6 parallel renders).
      </p>

      <div class="doc-sep" />

      <h2>SSR — Server-Side Rendering</h2>
      <CodeBlock code={`route("/dashboard", () => import("./routes/dashboard.tsx"), { render: "ssr" })`} />
      <p>
        HTML is generated fresh on every request. The loader runs server-side,
        the component renders to a string, and the full HTML response includes
        the serialized hydration state.
      </p>
      <p>
        After the initial load, client-side navigation takes over — subsequent
        navigations fetch only the loader data as JSON, not full HTML.
      </p>

      <h3>When to use SSR</h3>
      <ul>
        <li>Pages that depend on the request (cookies, auth, personalization)</li>
        <li>Data that changes on every request</li>
        <li>Pages where SEO matters and data is dynamic</li>
      </ul>

      <div class="doc-sep" />

      <h2>ISG — Incremental Static Generation</h2>
      <CodeBlock
        code={`import { timeRevalidate } from "viact";

route("/pricing", () => import("./routes/pricing.tsx"), {
  render: "isg",
  revalidate: timeRevalidate(3600), // revalidate every hour
})`}
      />
      <p>
        ISG generates HTML at build time (like SSG) but regenerates it after a
        configurable time window. On the first request after the window expires,
        the stale page is served immediately while a new version regenerates in
        the background — stale-while-revalidate.
      </p>
      <div class="callout callout-info">
        <span class="callout-icon">ℹ️</span>
        <span>
          ISG revalidation is implemented at the adapter level. The Node adapter
          uses file <code>mtime</code>; Cloudflare uses a cache timestamp in KV.
        </span>
      </div>

      <h3>Webhook revalidation (Phase 2)</h3>
      <CodeBlock code={`import { webhookRevalidate } from "viact";

{ revalidate: webhookRevalidate({ key: "pricing-update" }) }
// POST to the revalidation endpoint to trigger regeneration`} />

      <div class="doc-sep" />

      <h2>SPA — Single Page Application</h2>
      <CodeBlock code={`route("/settings", () => import("./routes/settings.tsx"), { render: "spa" })`} />
      <p>
        No server-side rendering. The server returns a minimal HTML shell, and
        the component renders entirely in the browser. The loader runs during
        client-side navigation only.
      </p>

      <h3>When to use SPA</h3>
      <ul>
        <li>Auth-gated pages where SEO doesn't matter</li>
        <li>Complex interactive UIs (editors, rich dashboards)</li>
        <li>Pages where server rendering adds no value</li>
      </ul>

      <div class="doc-sep" />

      <h2>Mixing Modes</h2>
      <p>
        The real power is mixing modes in a single app without separate
        deployments or frameworks:
      </p>
      <CodeBlock code={`export const app = defineApp({
  routes: [
    group({ shell: "public" }, [
      route("/",        () => import("..."), { render: "ssg" }),           // Static
      route("/pricing", () => import("..."), { render: "isg",             // Revalidating
        revalidate: timeRevalidate(3600) }),
      route("/login",   () => import("..."), { render: "ssr" }),           // Dynamic
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", () => import("..."), { render: "ssr" }),         // Personalized
      route("/settings",  () => import("..."), { render: "spa" }),         // Client-only
    ]),
  ],
});`} />

      <div class="doc-sep" />

      <h2>Client Navigation</h2>
      <p>
        After the initial page load — regardless of render mode — the client
        router handles all navigation. Route transitions use the same flow:
      </p>
      <ol style="padding-left:20px;color:var(--text-2);line-height:1.8;">
        <li>Client matches the new route</li>
        <li>Fetches loader data as JSON via <code>x-viact-route-state-request</code> header</li>
        <li>Updates the component tree with new data</li>
        <li>Pushes to browser history</li>
      </ol>
      <p>
        This means even SSG routes get fresh loader data during client
        navigation. The static HTML is only for the initial load and crawlers.
      </p>

      <div class="doc-nav">
        <a href="/docs/routing" class="doc-nav-card">
          <div class="doc-nav-dir">← Previous</div>
          <div class="doc-nav-title">Routing</div>
        </a>
        <a href="/docs/data-loading" class="doc-nav-card next">
          <div class="doc-nav-dir">Next</div>
          <div class="doc-nav-title">Data Loading →</div>
        </a>
      </div>
    </div>
  );
}
