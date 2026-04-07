import { CodeBlock } from "../../components/CodeBlock";

export function head() {
  return { title: "Middleware — viact docs" };
}

export function Component() {
  return (
    <div class="doc-page">
      <div class="breadcrumb">
        <a href="/">viact</a>
        <span class="breadcrumb-sep">/</span>
        <span>Middleware</span>
      </div>

      <h1 class="doc-title">Middleware</h1>
      <p class="doc-lead">
        Server-side request interceptors that run before loaders and actions.
        Use them for authentication, redirects, request validation, and context
        enrichment.
      </p>

      <h2>Defining Middleware</h2>
      <p>
        Middleware modules live in <code>src/middleware/</code> and export a{" "}
        <code>middleware</code> function:
      </p>
      <CodeBlock
        filename="src/middleware/auth.ts"
        code={`import type { MiddlewareFn } from "viact";

export const middleware: MiddlewareFn = async ({ request }) => {
  const session = await getSession(request);

  // Redirect unauthenticated users
  if (!session) {
    return { redirect: "/login" };
  }

  // Return void to continue to the loader
};`}
      />

      <div class="doc-sep" />

      <h2>Applying Middleware</h2>
      <p>
        Register middleware by name in <code>defineApp</code>, then reference
        them in routes or groups:
      </p>
      <CodeBlock
        filename="src/routes.ts"
        code={`export const app = defineApp({
  middleware: {
    auth: "./middleware/auth.ts",
    rateLimit: "./middleware/rate-limit.ts",
  },
  routes: [
    // Applied to a single route
    route("/profile", () => import("./routes/profile.tsx"), { middleware: ["auth"] }),

    // Applied to a group — all children inherit
    group({ middleware: ["auth"], shell: "app" }, [
      route("/dashboard", () => import("./routes/dashboard.tsx")),
      route("/settings", () => import("./routes/settings.tsx")),
    ]),
  ],
});`}
      />

      <div class="doc-sep" />

      <h2>Middleware Stacking</h2>
      <p>
        Middleware from groups and routes is combined. A route inside a group
        with <code>["auth"]</code> that also declares{" "}
        <code>["rateLimit"]</code> runs both in order:
      </p>
      <ol>
        <li><code>auth</code> (from group)</li>
        <li><code>rateLimit</code> (from route)</li>
        <li>Loader / action</li>
      </ol>

      <div class="doc-sep" />

      <h2>Middleware Results</h2>
      <div class="doc-table-wrap">
        <table class="doc-table">
          <thead>
            <tr><th>Return</th><th>Effect</th></tr>
          </thead>
          <tbody>
            <tr><td><code>undefined</code> / <code>void</code></td><td>Continue to the next middleware or loader</td></tr>
            <tr><td><code>{"{ redirect: \"/path\" }"}</code></td><td>HTTP 302 redirect</td></tr>
            <tr><td><code>{"{ response: new Response(...) }"}</code></td><td>Short-circuit with a custom response</td></tr>
          </tbody>
        </table>
      </div>

      <div class="doc-nav">
        <a href="/docs/api-routes" class="doc-nav-card prev">
          <div class="doc-nav-dir">Previous</div>
          <div class="doc-nav-title">← API Routes</div>
        </a>
        <a href="/docs/shells" class="doc-nav-card next">
          <div class="doc-nav-dir">Next</div>
          <div class="doc-nav-title">Shells →</div>
        </a>
      </div>
    </div>
  );
}
