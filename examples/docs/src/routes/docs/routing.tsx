import { CodeBlock } from "../../components/CodeBlock";

export function head() {
  return { title: "Routing — viact docs" };
}

export function Component() {
  return (
    <div class="doc-page">
      <div class="breadcrumb">
        <a href="/">viact</a>
        <span class="breadcrumb-sep">/</span>
        <span>Routing</span>
      </div>

      <h1 class="doc-title">Routing</h1>
      <p class="doc-lead">
        viact uses a hybrid routing model: route modules live as files by
        convention, but their wiring — shells, middleware, render modes, and URL
        patterns — is declared explicitly in a single{" "}
        <code>src/routes.ts</code> manifest.
      </p>

      <h2>Route Manifest</h2>
      <p>
        The manifest is the central source of truth for your app's routing.
        Define it in <code>src/routes.ts</code> using <code>defineApp</code>,{" "}
        <code>route</code>, and <code>group</code>:
      </p>
      <CodeBlock
        filename="src/routes.ts"
        code={`import { defineApp, group, route, timeRevalidate } from "viact";

export const app = defineApp({
  shells: {
    public: "./shells/public.tsx",
    app:    "./shells/app.tsx",
  },
  middleware: {
    auth: "./middleware/auth.ts",
  },
  routes: [
    group({ shell: "public" }, [
      route("/",        () => import("./routes/home.tsx"),    { render: "ssg" }),
      route("/pricing", () => import("./routes/pricing.tsx"), {
        render: "isg", revalidate: timeRevalidate(3600),
      }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", () => import("./routes/dashboard.tsx"), { render: "ssr" }),
      route("/settings",  () => import("./routes/settings.tsx"),  { render: "spa" }),
    ]),
  ],
});`}
      />

      <h3>Why explicit over file-based?</h3>
      <p>
        File-based routing (Next.js, SvelteKit) couples URL structure to
        directory structure. This forces awkward nesting for layout groups and
        makes middleware assignment implicit. viact's hybrid approach:
      </p>
      <ul>
        <li>Route modules live in <code>src/routes/</code> (discoverable by convention)</li>
        <li>Route <em>wiring</em> is explicit in <code>src/routes.ts</code> (auditable, type-checked)</li>
        <li>Shells and middleware are named references (reusable across groups)</li>
        <li>URL structure is independent of file system layout</li>
      </ul>

      <div class="doc-sep" />

      <h2>API Reference</h2>

      <h3>defineApp(config)</h3>
      <div class="doc-table-wrap">
        <table class="doc-table">
          <thead>
            <tr><th>Field</th><th>Type</th><th>Description</th></tr>
          </thead>
          <tbody>
            <tr><td>shells</td><td>Record&lt;string, string&gt;</td><td>Named shell modules — key is the name, value is the file path</td></tr>
            <tr><td>middleware</td><td>Record&lt;string, string&gt;</td><td>Named middleware modules</td></tr>
            <tr><td>routes</td><td>(RouteDefinition | GroupDefinition)[]</td><td>The route tree</td></tr>
          </tbody>
        </table>
      </div>

      <h3>route(path, component, meta?)</h3>
      <div class="doc-table-wrap">
        <table class="doc-table">
          <thead>
            <tr><th>Param</th><th>Type</th><th>Description</th></tr>
          </thead>
          <tbody>
            <tr><td>path</td><td>string</td><td>URL pattern, e.g. <code>/blog/:slug</code></td></tr>
            <tr><td>component</td><td>{"() => Promise<any>"}</td><td>Lazy import function for the route module</td></tr>
            <tr><td>meta</td><td>RouteMeta</td><td>Optional render mode, shell, middleware, revalidation</td></tr>
          </tbody>
        </table>
      </div>
      <p>
        The <code>component</code> argument is a dynamic <code>import()</code>{" "}
        expression, giving you IDE jump-to-definition and TypeScript module
        resolution. String paths are still accepted for backward compatibility.
      </p>

      <h3>group(meta, routes)</h3>
      <p>
        Groups routes with shared configuration. Properties cascade to children;
        a route's own meta overrides the group's.
      </p>
      <div class="doc-table-wrap">
        <table class="doc-table">
          <thead>
            <tr><th>Param</th><th>Type</th><th>Description</th></tr>
          </thead>
          <tbody>
            <tr><td>meta</td><td>GroupMeta</td><td>Shell, middleware, render mode, pathPrefix to inherit</td></tr>
            <tr><td>routes</td><td>RouteDefinition[]</td><td>Routes in this group</td></tr>
          </tbody>
        </table>
      </div>

      <div class="doc-sep" />

      <h2>Path Patterns</h2>

      <h3>Static paths</h3>
      <CodeBlock code={`route("/about", () => import("./routes/about.tsx"))
// Matches /about exactly`} />

      <h3>Dynamic segments</h3>
      <CodeBlock code={`route("/blog/:slug", () => import("./routes/blog-post.tsx"))
// /blog/hello-world → params.slug = "hello-world"

route("/users/:userId/posts/:postId", () => import("./routes/user-post.tsx"))
// Multiple dynamic segments`} />

      <h3>Catch-all segments</h3>
      <CodeBlock code={`route("/docs/*", () => import("./routes/docs.tsx"))
// Matches /docs/a/b/c — catch-all available in params`} />

      <div class="doc-sep" />

      <h2>Shells</h2>
      <p>
        Shells are Preact layout components that wrap route content. They are{" "}
        <strong>decoupled from URL structure</strong> — a flat URL like{" "}
        <code>/settings</code> can use the <code>app</code> shell without
        nesting under <code>/app/settings</code>.
      </p>
      <CodeBlock
        filename="src/shells/app.tsx"
        code={`import type { ShellProps } from "viact";

export function Shell({ children }: ShellProps) {
  return (
    <div class="app-layout">
      <Sidebar />
      <main>{children}</main>
    </div>
  );
}

// Optional: shell-level <head> metadata
export function head() {
  return { title: "My App" };
}`}
      />
      <div class="callout callout-note">
        <span class="callout-icon">💡</span>
        <span>
          Shell head metadata merges with route-level head. Route head takes
          precedence for <code>title</code>. Arrays like <code>meta</code> and{" "}
          <code>link</code> are concatenated.
        </span>
      </div>

      <div class="doc-sep" />

      <h2>Middleware</h2>
      <p>
        Middleware runs server-side before the loader. It can redirect, modify
        context, or throw errors.
      </p>
      <CodeBlock
        filename="src/middleware/auth.ts"
        code={`import type { MiddlewareFn } from "viact";

export const middleware: MiddlewareFn = async ({ request }) => {
  const session = await getSession(request);
  if (!session) return { redirect: "/login" };
  // Return void to continue to the loader
};`}
      />
      <p>
        Middleware stacks within groups — a route inside a group with{" "}
        <code>["auth"]</code> that also declares <code>["rateLimit"]</code> runs
        both in order.
      </p>

      <div class="doc-sep" />

      <h2>Path Prefix Groups</h2>
      <p>
        Groups can add a URL prefix to all child routes, keeping route files
        flat while grouping URLs logically:
      </p>
      <CodeBlock code={`group({ pathPrefix: "/admin", shell: "admin", middleware: ["auth"] }, [
  route("/",       () => import("./routes/admin/index.tsx")),   // → /admin
  route("/users",  () => import("./routes/admin/users.tsx")),   // → /admin/users
  route("/settings", () => import("./routes/admin/settings.tsx")), // → /admin/settings
])`} />

      <div class="doc-nav">
        <a href="/docs/getting-started" class="doc-nav-card prev">
          <div class="doc-nav-dir">Previous</div>
          <div class="doc-nav-title">← Getting Started</div>
        </a>
        <a href="/docs/rendering" class="doc-nav-card next">
          <div class="doc-nav-dir">Next</div>
          <div class="doc-nav-title">Rendering Modes →</div>
        </a>
      </div>
    </div>
  );
}
