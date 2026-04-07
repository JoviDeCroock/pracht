import { CodeBlock } from "../../components/CodeBlock";

export function head() {
  return { title: "Prefetching — viact docs" };
}

export function Component() {
  return (
    <div class="doc-page">
      <div class="breadcrumb">
        <a href="/">viact</a>
        <span class="breadcrumb-sep">/</span>
        <span>Prefetching</span>
      </div>

      <h1 class="doc-title">Prefetching</h1>
      <p class="doc-lead">
        viact prefetches route data before navigation so page transitions feel
        instant. Prefetching is automatic for server-rendered routes and can be
        configured per route.
      </p>

      <h2>How It Works</h2>
      <p>
        After hydration, viact sets up document-level listeners that watch for
        user interaction with internal links. When a prefetch is triggered, the
        route's server data (the same JSON payload used during client-side
        navigation) is fetched in the background and cached. When the user
        actually clicks the link, the cached data is used immediately — no
        second network request.
      </p>
      <p>
        Prefetched data is held in a 30-second TTL cache. Stale entries are
        discarded and re-fetched on the next interaction.
      </p>

      <div class="doc-sep" />

      <h2>Strategies</h2>
      <p>
        Each route can declare a <code>prefetch</code> strategy in its route
        meta:
      </p>
      <div class="doc-table-wrap">
        <table class="doc-table">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Trigger</th>
              <th>Best For</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>"intent"</code></td>
              <td>Mouse hover or keyboard focus (50ms debounce)</td>
              <td>Most routes — low overhead, high hit rate</td>
            </tr>
            <tr>
              <td><code>"viewport"</code></td>
              <td>Link scrolls into view (IntersectionObserver)</td>
              <td>Navigation menus, link-heavy pages</td>
            </tr>
            <tr>
              <td><code>"hover"</code></td>
              <td>Same as intent (hover + focus)</td>
              <td>Alias for intent</td>
            </tr>
            <tr>
              <td><code>"none"</code></td>
              <td>Disabled</td>
              <td>SPA routes, rarely visited pages</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="doc-sep" />

      <h2>Defaults</h2>
      <p>
        You don't need to configure anything for most apps. The defaults are:
      </p>
      <ul>
        <li>
          <strong>SSR, SSG, ISG routes</strong> — <code>"intent"</code>{" "}
          (prefetch on hover/focus)
        </li>
        <li>
          <strong>SPA routes</strong> — <code>"none"</code> (SPA routes
          already fetch data on load, so prefetching the server payload has no
          benefit)
        </li>
      </ul>

      <div class="doc-sep" />

      <h2>Per-Route Configuration</h2>
      <p>
        Override the default strategy with the <code>prefetch</code> field on
        a route:
      </p>
      <CodeBlock
        filename="src/routes.ts"
        code={`import { defineApp, route, group } from "viact";

export const app = defineApp({
  routes: [
    // Prefetch when the link enters the viewport
    route("/pricing", () => import("./routes/pricing.tsx"), {
      render: "isg",
      prefetch: "viewport",
    }),

    // Disable prefetching for a rarely visited page
    route("/terms", () => import("./routes/terms.tsx"), {
      render: "ssg",
      prefetch: "none",
    }),

    // Default: intent-based prefetching (hover/focus)
    route("/about", () => import("./routes/about.tsx"), { render: "ssg" }),
  ],
});`}
      />

      <div class="doc-sep" />

      <h2>Viewport Prefetching</h2>
      <p>
        When a route uses <code>"viewport"</code>, viact observes all{" "}
        <code>&lt;a&gt;</code> elements pointing to that route via an{" "}
        <code>IntersectionObserver</code> with a 200px root margin. As soon as
        the link scrolls near the viewport, the route data is prefetched. Each
        link is only observed once — after the first intersection, it is
        unobserved to avoid redundant work.
      </p>
      <p>
        After client-side navigation updates the DOM, a{" "}
        <code>MutationObserver</code> re-scans for new viewport-prefetch links
        automatically.
      </p>

      <div class="doc-sep" />

      <h2>Cache Behavior</h2>
      <ul>
        <li>
          Prefetch results are cached for <strong>30 seconds</strong>. After
          that, the entry is evicted and re-fetched on the next trigger.
        </li>
        <li>
          The cache is keyed by URL (pathname + search). Different query
          parameters are cached separately.
        </li>
        <li>
          If a prefetch is in flight when the user clicks the link, the
          in-flight promise is reused — no duplicate request.
        </li>
        <li>
          The cache is shared across all prefetch strategies. A viewport
          prefetch can be consumed by a subsequent click, and vice versa.
        </li>
      </ul>

      <div class="doc-nav">
        <a href="/docs/adapters" class="doc-nav-card prev">
          <div class="doc-nav-dir">Previous</div>
          <div class="doc-nav-title">← Adapters</div>
        </a>
        <a href="/docs/performance" class="doc-nav-card next">
          <div class="doc-nav-dir">Next</div>
          <div class="doc-nav-title">Performance →</div>
        </a>
      </div>
    </div>
  );
}
