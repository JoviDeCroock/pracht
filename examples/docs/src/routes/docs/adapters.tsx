import { CodeBlock } from "../../components/CodeBlock";

export function head() {
  return { title: "Adapters — viact docs" };
}

export function Component() {
  return (
    <div class="doc-page">
      <div class="breadcrumb">
        <a href="/">viact</a>
        <span class="breadcrumb-sep">/</span>
        <a href="/docs/routing">Docs</a>
        <span class="breadcrumb-sep">/</span>
        <span>Adapters</span>
      </div>

      <h1 class="doc-title">Adapters</h1>
      <p class="doc-lead">
        Adapters are thin layers that translate between a platform's native request handling and
        viact's Web Request/Response interface. viact ships adapters for Cloudflare Workers, Vercel
        Edge Functions, and Node.js.
      </p>

      <h2>Architecture</h2>
      <p>Every adapter follows the same request flow:</p>
      <CodeBlock
        code={`Platform request (Node / CF / Vercel)
  → Convert to Web Request
  → Is this a static asset?  → Yes: serve from dist/client/
  → Is this a prerendered page?  → Yes: serve static HTML (check ISG staleness)
  → Delegate to handleViactRequest()
  → Convert Web Response back to platform response`}
      />

      <div class="doc-sep" />

      <h2>Cloudflare Workers</h2>
      <p>
        Deploy to Cloudflare's global edge network. Static assets are served from the{" "}
        <code>ASSETS</code> binding, and dynamic routes are handled by the Worker.
      </p>

      <h3>Setup</h3>
      <CodeBlock
        filename="vite.config.ts"
        code={`import { defineConfig } from "vite";
import { viact } from "@viact/vite-plugin";

export default defineConfig({
  plugins: [viact({ adapter: "cloudflare" })],
});`}
      />
      <CodeBlock
        filename="package.json"
        code={`{
  "dependencies": {
    "viact": "*",
    "@viact/adapter-cloudflare": "*"
  }
}`}
      />

      <h3>Build output</h3>
      <p>
        Running <code>viact build</code> with the Cloudflare adapter emits:
      </p>
      <CodeBlock
        code={`dist/
  client/          // static assets served via ASSETS binding
    assets/
    index.html     // SSG pages
  server/
    server.js      // Worker bundle`}
      />
      <p>
        Keep your <code>wrangler.jsonc</code> in the project root so you can add bindings without
        the build overwriting them.
      </p>

      <h3>Accessing Cloudflare bindings</h3>
      <p>
        The <code>env</code> object is passed through to your loaders and actions via the context:
      </p>
      <CodeBlock
        code={`// src/routes/dashboard.tsx
export async function loader({ context }: LoaderArgs) {
  // context.env is the Cloudflare env object
  const user = await context.env.DB.prepare(
    "SELECT * FROM users WHERE id = ?"
  ).bind(userId).first();
  return { user };
}`}
      />

      <h3>Deploy</h3>
      <CodeBlock
        code={`viact build
npx wrangler deploy`}
      />

      <div class="doc-sep" />

      <h2>Vercel Edge Functions</h2>
      <p>
        Deploy using Vercel's Build Output API v3. SSG pages are served from the static file system;
        SSR and ISG routes go through the Edge Function.
      </p>

      <h3>Setup</h3>
      <CodeBlock
        code={`// vite.config.ts
viact({ adapter: "vercel" })

// package.json
"@viact/adapter-vercel": "*"`}
      />

      <h3>Build output</h3>
      <CodeBlock
        code={`.vercel/
  output/
    config.json    // routes, rewrites, headers
    static/        // SSG pages served from the filesystem
    functions/
      render.func/ // Edge Function for SSR/ISG/API routes`}
      />

      <h3>Deploy</h3>
      <CodeBlock
        code={`viact build
npx vercel deploy --prebuilt`}
      />

      <div class="doc-sep" />

      <h2>Node.js</h2>
      <p>
        Run viact as a standard Node.js HTTP server. The adapter handles static file serving, ISG
        stale-while-revalidate, request translation, and the generated{" "}
        <code>dist/server/server.js</code> entry boots the production server directly.
      </p>

      <h3>Setup</h3>
      <CodeBlock
        code={`// vite.config.ts
viact({ adapter: "node" })

// package.json
"@viact/adapter-node": "*"`}
      />

      <h3>Deploy</h3>
      <CodeBlock
        code={`viact build
node dist/server/server.js
// Server listening on http://localhost:3000`}
      />

      <div class="doc-sep" />

      <h2>Context Factory</h2>
      <p>
        Adapters inject platform-specific values into loaders and actions via a context factory.
        This is where you connect database clients, environment bindings, and other platform
        resources:
      </p>
      <CodeBlock
        code={`// Node: inject a database pool
createContext: ({ request }) => ({
  db: pool,
  ip: request.headers.get("x-forwarded-for"),
})

// Cloudflare: expose env bindings
createContext: ({ request, env, executionContext }) => ({
  db: env.DB,        // D1 binding
  kv: env.CACHE,     // KV binding
  r2: env.STORAGE,   // R2 binding
  waitUntil: executionContext.waitUntil.bind(executionContext),
})`}
      />
      <p>
        The context object is available as <code>args.context</code> in every loader, action,
        middleware, and API route handler.
      </p>

      <div class="doc-sep" />

      <h2>Writing a Custom Adapter</h2>
      <p>A custom adapter needs to:</p>
      <ol style="padding-left:20px;color:var(--text-2);line-height:1.85;">
        <li>
          Accept a platform request and convert it to a Web <code>Request</code>
        </li>
        <li>
          Check for static assets — serve files from <code>dist/client/</code> with appropriate
          headers
        </li>
        <li>Check for prerendered pages — serve SSG/ISG HTML (with staleness checking for ISG)</li>
        <li>
          Delegate dynamic requests to <code>handleViactRequest()</code> from <code>viact</code>
        </li>
        <li>
          Convert the Web <code>Response</code> back to the platform's response format
        </li>
        <li>Provide a context factory for platform-specific values</li>
        <li>Export an entry module generator for the Vite plugin</li>
      </ol>

      <div class="callout callout-info">
        <span class="callout-icon">ℹ️</span>
        <span>
          See the source of <code>@viact/adapter-cloudflare</code> or{" "}
          <code>@viact/adapter-node</code> in the monorepo for a concrete reference implementation.
        </span>
      </div>

      <div class="doc-nav">
        <a href="/docs/deployment" class="doc-nav-card">
          <div class="doc-nav-dir">← Previous</div>
          <div class="doc-nav-title">Deployment</div>
        </a>
        <a href="/docs/prefetching" class="doc-nav-card next">
          <div class="doc-nav-dir">Next</div>
          <div class="doc-nav-title">Prefetching →</div>
        </a>
      </div>
    </div>
  );
}
