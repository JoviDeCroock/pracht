export function createViteConfig(adapter, router, tailwind) {
  const ADAPTER_IMPORTS = {
    node: { fn: "nodeAdapter", pkg: "@pracht/adapter-node" },
    cloudflare: { fn: "cloudflareAdapter", pkg: "@pracht/adapter-cloudflare" },
    netlify: { fn: "netlifyAdapter", pkg: "@pracht/adapter-netlify" },
    vercel: { fn: "vercelAdapter", pkg: "@pracht/adapter-vercel" },
  };

  const info = ADAPTER_IMPORTS[adapter.id] ?? ADAPTER_IMPORTS.node;

  const prachtOptions =
    router === "pages"
      ? `{ pagesDir: "/src/pages", adapter: ${info.fn}(), llmsTxt: {} }`
      : `{ adapter: ${info.fn}(), llmsTxt: {} }`;

  const plugins = tailwind
    ? `[pracht(${prachtOptions}), tailwindcss()]`
    : `[pracht(${prachtOptions})]`;

  const lines = [
    'import { defineConfig } from "vite";',
    'import { pracht } from "@pracht/vite-plugin";',
    `import { ${info.fn} } from "${info.pkg}";`,
  ];

  if (tailwind) {
    lines.push('import tailwindcss from "@tailwindcss/vite";');
  }

  lines.push("", "export default defineConfig({", `  plugins: ${plugins},`, "});", "");

  return lines.join("\n");
}

export function createRoutesFile() {
  return [
    'import { defineApp, route } from "@pracht/core";',
    "",
    "export const app = defineApp({",
    "  shells: {",
    '    public: "./shells/public.tsx",',
    "  },",
    "  routes: [",
    '    route("/", "./routes/home.tsx", { id: "home", render: "ssg", shell: "public" }),',
    "  ],",
    "  // Rendered with a 404 status when nothing matches. Not a route: it never",
    "  // matches a URL, so it cannot shadow static assets or later pages.",
    "  notFound: {",
    '    component: "./routes/not-found.tsx",',
    '    shell: "public",',
    "  },",
    "  // Declarative invariants enforced by `pracht verify` — uncomment to use",
    "  // (add the helpers to the @pracht/core import):",
    "  // constraints: [",
    '  //   requireHead("**"),',
    "  // ],",
    "});",
    "",
  ].join("\n");
}

export function createShellFile(projectName, tailwind = false) {
  const lines = ['import type { ShellProps } from "@pracht/core";'];

  if (tailwind) {
    lines.push('import "../styles/global.css";');
  }

  return [
    ...lines,
    "",
    "export function Shell({ children }: ShellProps) {",
    "  return (",
    '    <div style={{ fontFamily: "Inter, system-ui, sans-serif", margin: "0 auto", maxWidth: "720px", padding: "48px 20px" }}>',
    '      <header style={{ marginBottom: "32px" }}>',
    `        <strong>${projectName}</strong>`,
    '        <p style={{ color: "#555", margin: "8px 0 0" }}>A new pracht app.</p>',
    "      </header>",
    "      <main>{children}</main>",
    "    </div>",
    "  );",
    "}",
    "",
    "export function head() {",
    "  return {",
    '    meta: [{ content: "width=device-width, initial-scale=1", name: "viewport" }],',
    `    title: ${JSON.stringify(projectName)},`,
    "  };",
    "}",
    "",
  ].join("\n");
}

export function createHomeRoute(adapter) {
  return [
    'import type { LoaderArgs, RouteComponentProps } from "@pracht/core";',
    "",
    "export async function loader(_args: LoaderArgs) {",
    "  return {",
    `    adapter: ${JSON.stringify(adapter.label)},`,
    "    steps: [",
    '      "Edit src/routes/home.tsx to change this page.",',
    '      "Add more routes in src/routes.ts.",',
    '      "Add API handlers in src/api/*.ts.",',
    "    ],",
    "  };",
    "}",
    "",
    "export function Component({ data }: RouteComponentProps<typeof loader>) {",
    "  return (",
    "    <section>",
    '      <p style={{ color: "#555", marginBottom: "8px" }}>Starter ready.</p>',
    '      <h1 style={{ fontSize: "2.5rem", lineHeight: 1.1, margin: "0 0 16px" }}>Your pracht app is up and running.</h1>',
    '      <p style={{ fontSize: "1.1rem", lineHeight: 1.6, marginBottom: "24px" }}>',
    "        This starter is configured for <strong>{data.adapter}</strong>.",
    "      </p>",
    '      <ul style={{ lineHeight: 1.8, paddingLeft: "20px" }}>',
    "        {data.steps.map((step) => (",
    "          <li key={step}>{step}</li>",
    "        ))}",
    "      </ul>",
    '      <p style={{ marginTop: "24px" }}>',
    "        Check <code>/api/health</code> for a simple API route.",
    "      </p>",
    "    </section>",
    "  );",
    "}",
    "",
  ].join("\n");
}

export function createNotFoundRoute() {
  return [
    "export function head() {",
    "  return {",
    '    title: "Page not found",',
    '    meta: [{ content: "noindex", name: "robots" }],',
    "  };",
    "}",
    "",
    "export function Component() {",
    "  return (",
    "    <section>",
    '      <p style={{ color: "#555", marginBottom: "8px" }}>404</p>',
    '      <h1 style={{ fontSize: "2.5rem", lineHeight: 1.1, margin: "0 0 16px" }}>Page not found.</h1>',
    '      <p style={{ fontSize: "1.1rem", lineHeight: 1.6, marginBottom: "24px" }}>',
    "        The page you asked for does not exist. It may have moved, or the link may be wrong.",
    "      </p>",
    "      {/* A plain anchor keeps this page independent of the route table.",
    "          Use a typed <Link> once you want client-side navigation. */}",
    '      <a href="/">Back to home</a>',
    "    </section>",
    "  );",
    "}",
    "",
  ].join("\n");
}

export function createPagesHomeRoute(adapter) {
  return [
    'import type { LoaderArgs, RouteComponentProps } from "@pracht/core";',
    "",
    'export const RENDER_MODE = "ssg";',
    "",
    "export async function loader(_args: LoaderArgs) {",
    "  return {",
    `    adapter: ${JSON.stringify(adapter.label)},`,
    "    steps: [",
    '      "Edit src/pages/index.tsx to change this page.",',
    '      "Add more pages in src/pages/.",',
    '      "Add API handlers in src/api/*.ts.",',
    "    ],",
    "  };",
    "}",
    "",
    "export function Component({ data }: RouteComponentProps<typeof loader>) {",
    "  return (",
    "    <section>",
    '      <p style={{ color: "#555", marginBottom: "8px" }}>Starter ready.</p>',
    '      <h1 style={{ fontSize: "2.5rem", lineHeight: 1.1, margin: "0 0 16px" }}>Your pracht app is up and running.</h1>',
    '      <p style={{ fontSize: "1.1rem", lineHeight: 1.6, marginBottom: "24px" }}>',
    "        This starter is configured for <strong>{data.adapter}</strong>.",
    "      </p>",
    '      <ul style={{ lineHeight: 1.8, paddingLeft: "20px" }}>',
    "        {data.steps.map((step) => (",
    "          <li key={step}>{step}</li>",
    "        ))}",
    "      </ul>",
    '      <p style={{ marginTop: "24px" }}>',
    "        Check <code>/api/health</code> for a simple API route.",
    "      </p>",
    "    </section>",
    "  );",
    "}",
    "",
  ].join("\n");
}

export function createBaseTSConfig(_adapter) {
  const config = {
    compilerOptions: {
      allowImportingTsExtensions: true,
      jsx: "react-jsx",
      jsxImportSource: "preact",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      module: "ESNext",
      moduleResolution: "Bundler",
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: "ES2022",
      types: ["vite/client"],
      verbatimModuleSyntax: true,
    },
  };
  return JSON.stringify(config, null, 4);
}

export function createHealthRoute(adapter) {
  return [
    "export function GET() {",
    "  return Response.json({",
    `    adapter: ${JSON.stringify(adapter.short)},`,
    "    ok: true,",
    '    service: "pracht",',
    "  });",
    "}",
    "",
  ].join("\n");
}
