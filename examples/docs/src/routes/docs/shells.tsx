import { CodeBlock } from "../../components/CodeBlock";

export function head() {
  return { title: "Shells — viact docs" };
}

export function Component() {
  return (
    <div class="doc-page">
      <div class="breadcrumb">
        <a href="/">viact</a>
        <span class="breadcrumb-sep">/</span>
        <span>Shells</span>
      </div>

      <h1 class="doc-title">Shells</h1>
      <p class="doc-lead">
        Layout wrappers that surround route content. Shells are decoupled from
        URL structure — a flat route like <code>/settings</code> can share a
        shell with <code>/dashboard</code> without nesting.
      </p>

      <h2>Defining a Shell</h2>
      <p>
        Shell modules live in <code>src/shells/</code> and export a{" "}
        <code>Shell</code> component:
      </p>
      <CodeBlock
        filename="src/shells/app.tsx"
        code={`import type { ShellProps } from "viact";

export function Shell({ children }: ShellProps) {
  return (
    <div class="app-layout">
      <nav class="sidebar">
        <a href="/dashboard">Dashboard</a>
        <a href="/settings">Settings</a>
      </nav>
      <main>{children}</main>
    </div>
  );
}`}
      />

      <div class="doc-sep" />

      <h2>Shell Head Metadata</h2>
      <p>
        Shells can contribute to <code>&lt;head&gt;</code> by exporting a{" "}
        <code>head</code> function. Shell metadata merges with route-level
        metadata:
      </p>
      <CodeBlock
        code={`// Shell exports head() for shared metadata
export function head() {
  return {
    title: "My App",
    meta: [
      { name: "viewport", content: "width=device-width, initial-scale=1" },
    ],
  };
}

// Route can override title, arrays are concatenated
export function head() {
  return { title: "Dashboard — My App" };
}`}
      />
      <div class="callout callout-note">
        <span class="callout-icon">Note</span>
        <span>
          Route <code>title</code> overrides shell <code>title</code>. Array
          fields like <code>meta</code> and <code>link</code> are merged.
        </span>
      </div>

      <div class="doc-sep" />

      <h2>Assigning Shells</h2>
      <p>
        Register shells by name in <code>defineApp</code>, then reference them
        in routes or groups:
      </p>
      <CodeBlock
        filename="src/routes.ts"
        code={`export const app = defineApp({
  shells: {
    public: "./shells/public.tsx",
    app: "./shells/app.tsx",
  },
  routes: [
    // Per-route
    route("/", () => import("./routes/home.tsx"), { shell: "public" }),

    // Per-group — all children inherit
    group({ shell: "app" }, [
      route("/dashboard", () => import("./routes/dashboard.tsx")),
      route("/settings", () => import("./routes/settings.tsx")),
    ]),
  ],
});`}
      />

      <div class="doc-sep" />

      <h2>Client-Side Navigation</h2>
      <p>
        When navigating between routes that share the same shell, viact
        preserves the shell and only re-renders the route content. When crossing
        shell boundaries, the full page tree is re-rendered.
      </p>

      <div class="doc-nav">
        <a href="/docs/middleware" class="doc-nav-card prev">
          <div class="doc-nav-dir">Previous</div>
          <div class="doc-nav-title">← Middleware</div>
        </a>
        <a href="/docs/cli" class="doc-nav-card next">
          <div class="doc-nav-dir">Next</div>
          <div class="doc-nav-title">CLI →</div>
        </a>
      </div>
    </div>
  );
}
