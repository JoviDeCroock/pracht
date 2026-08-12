import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  DEFAULT_DIRECTORY,
  FALLBACK_VERSION_RANGES,
  SKILL_DIRS,
  WRANGLER_COMPATIBILITY_DATE,
} from "./config.js";
import {
  createPnpmWorkspaceConfig,
  findAncestorPnpmWorkspace,
  pnpmBuildAllowlist,
  pnpmBuildPolicyName,
} from "./workspace-policy.js";

async function fetchLatestVersion(packageName) {
  const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
  if (!res.ok) {
    throw new Error(`Failed to fetch version for ${packageName}: ${res.statusText}`);
  }
  const data = await res.json();
  return data.version;
}

export async function scaffoldProject({
  adapter,
  agentTools = true,
  packageManager,
  pnpmMajor = 11,
  resolveRemoteVersions = true,
  router = "manifest",
  tailwind = false,
  targetDir,
}) {
  const packageName = toPackageName(basename(targetDir));
  const { files, pnpmWorkspaceNotice } = await buildProjectFiles({
    adapter,
    agentTools,
    packageManager,
    pnpmMajor,
    projectName: packageName,
    resolveRemoteVersions,
    router,
    tailwind,
    targetDir,
  });

  await mkdir(targetDir, { recursive: true });

  // pnpm resolves build-script policy from the workspace root, so inside an existing
  // monorepo our own file would be read by nobody — and `pnpm install` run from
  // the app directory would find it first and re-root the workspace there,
  // detaching the app from its siblings. Tell the user what to add instead.
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = resolve(targetDir, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
  }

  // AGENTS.md (and the CLAUDE.md alias pointing at it) are agent tooling too —
  // `--no-agent-tools` means a project with none of it, not "all of it except
  // the instruction files". README.md carries the same commands for humans.
  if (!agentTools) return { pnpmWorkspaceNotice };

  try {
    await symlink("AGENTS.md", resolve(targetDir, "CLAUDE.md"));
  } catch (error) {
    if (error && typeof error === "object" && ["EPERM", "EINVAL"].includes(error.code)) {
      await copyFile(resolve(targetDir, "AGENTS.md"), resolve(targetDir, "CLAUDE.md"));
    } else {
      throw error;
    }
  }

  return { pnpmWorkspaceNotice };
}

async function resolveVersions(packageNames, { remote = true } = {}) {
  const entries = await Promise.all(
    packageNames.map(async (name) => {
      const fallback = FALLBACK_VERSION_RANGES[name] ?? "latest";
      if (!remote) return [name, fallback];
      try {
        return [name, `^${await fetchLatestVersion(name)}`];
      } catch {
        return [name, fallback];
      }
    }),
  );
  return Object.fromEntries(entries);
}

export async function buildProjectFiles({
  adapter,
  agentTools = true,
  packageManager,
  pnpmMajor = 11,
  projectName,
  resolveRemoteVersions = true,
  router,
  tailwind = false,
  targetDir,
}) {
  const packagesToResolve = [
    "@pracht/cli",
    "@pracht/vite-plugin",
    "@pracht/core",
    adapter.packageName,
    "typescript",
  ];
  if (adapter.id === "vercel") {
    packagesToResolve.push("vercel");
  }
  if (adapter.id === "netlify") {
    packagesToResolve.push("netlify-cli");
  }
  if (tailwind) {
    packagesToResolve.push("tailwindcss", "@tailwindcss/vite");
  }

  const versions = await resolveVersions(packagesToResolve, { remote: resolveRemoteVersions });
  const policyMajor = pnpmMajor ?? 11;
  const ancestorWorkspace = targetDir ? findAncestorPnpmWorkspace(targetDir) : null;
  const pnpmWorkspaceNotice = ancestorWorkspace
    ? {
        packages: pnpmBuildAllowlist(adapter, tailwind),
        policy: pnpmBuildPolicyName(policyMajor),
        root: ancestorWorkspace,
      }
    : null;

  const files = {
    ".gitignore":
      "dist\nnode_modules\n.netlify\n.wrangler\n.vercel\n.env*\n!.env.example\n.dev.vars\n# Keep .pracht/app-graph.json committed — it is the `pracht plan` snapshot.\n",
    "README.md": createReadme({
      adapter,
      agentTools,
      packageManager,
      pnpmMajor,
      pnpmWorkspaceNotice,
      projectName,
      router,
      tailwind,
    }),
    "package.json": createPackageJson({
      adapter,
      projectName,
      tailwind,
      versions,
    }),
    "src/api/health.ts": createHealthRoute(adapter),
    "vite.config.ts": createViteConfig(adapter, router, tailwind),
    "tsconfig.json": createBaseTSConfig(adapter),
  };

  if (agentTools) {
    files["AGENTS.md"] = createAgentInstructions({
      adapter,
      agentTools,
      packageManager,
      router,
      tailwind,
    });
  }

  if (router === "pages") {
    files["src/pages/_app.tsx"] = createShellFile(projectName, tailwind);
    files["src/pages/index.tsx"] = createPagesHomeRoute(adapter);
    files["src/pages/404.tsx"] = createNotFoundRoute();
  } else {
    files["src/routes.ts"] = createRoutesFile();
    files["src/routes/home.tsx"] = createHomeRoute(adapter);
    files["src/routes/not-found.tsx"] = createNotFoundRoute();
    files["src/shells/public.tsx"] = createShellFile(projectName, tailwind);
  }

  if (tailwind) {
    files["src/styles/global.css"] = '@import "tailwindcss";\n';
  }

  if (adapter.id === "cloudflare") {
    files["wrangler.jsonc"] = createWranglerConfig(projectName);
    files["src/env.d.ts"] = createCloudflareEnvDeclaration();
  }

  if (adapter.id === "netlify") {
    files["netlify.toml"] = createNetlifyConfig(packageManager);
  }

  if (adapter.id === "node") {
    files["Dockerfile"] = createDockerfile(packageManager);
    files[".dockerignore"] = createDockerignore();
  }

  if (agentTools) {
    files[".mcp.json"] = createMcpConfig();
    Object.assign(files, await readSkillFiles());
  }

  // pnpm resolves build-script policy from the workspace root, so inside an existing
  // workspace our own file would be read by nobody — and `pnpm install` run
  // from the app directory would find it first and re-root the workspace there,
  // detaching the app from its siblings. Decided here so the `--json` and
  // `--dry-run` listings match what is actually written.
  if (!pnpmWorkspaceNotice) {
    files["pnpm-workspace.yaml"] = createPnpmWorkspaceConfig(adapter, tailwind, policyMajor);
  }

  return { files, pnpmWorkspaceNotice };
}

function createMcpConfig() {
  return `${JSON.stringify(
    {
      mcpServers: {
        pracht: {
          command: "npx",
          // `--no-install` pins this to the `@pracht/cli` the project depends
          // on. `--yes @pracht/cli` fetched the registry's latest instead, so
          // the MCP server an agent talked to could describe a different CLI
          // than the one the app builds with. Not bare `npx pracht` either:
          // that resolves to a registry package literally named `pracht`
          // whenever the local bin is missing — `--no-install` fails loudly.
          args: ["--no-install", "pracht", "mcp"],
        },
      },
    },
    null,
    2,
  )}\n`;
}

async function readSkillFiles() {
  const skillsDir = SKILL_DIRS.find((dir) => existsSync(dir));

  if (!skillsDir) {
    return {};
  }

  const files = {};
  for (const name of await readdir(skillsDir)) {
    const skillFile = resolve(skillsDir, name, "SKILL.md");
    if (!existsSync(skillFile)) {
      continue;
    }
    files[`.claude/skills/${name}/SKILL.md`] = await readFile(skillFile, "utf-8");
  }

  return files;
}

function createPackageJson({ adapter, projectName, tailwind, versions }) {
  const scripts = {
    build: "pracht build",
    dev: "pracht dev",
    typecheck: "tsc --noEmit",
  };

  if (adapter.id === "node") {
    scripts.preview = "pracht preview";
    scripts.start = "node dist/server/server.js";
  }

  const devDependencies = {
    "@pracht/cli": versions["@pracht/cli"],
    "@pracht/vite-plugin": versions["@pracht/vite-plugin"],
    preact: "^10.26.9",
    "preact-render-to-string": "^6.5.13",
    typescript: versions["typescript"],
    vite: "^8.0.0",
  };

  if (adapter.id === "cloudflare") {
    scripts.deploy = "pracht build && wrangler deploy";
    scripts.preview = "pracht preview";
    devDependencies.wrangler = "^4.81.0";
  }

  if (adapter.id === "netlify") {
    scripts.deploy = "netlify deploy --build --prod";
    scripts.preview = "pracht build && netlify dev";
    devDependencies["netlify-cli"] = versions["netlify-cli"];
  }

  if (adapter.id === "vercel") {
    scripts.deploy = "pracht build && vercel deploy --prebuilt";
    devDependencies.vercel = versions["vercel"];
  }

  if (tailwind) {
    devDependencies["@tailwindcss/vite"] = versions["@tailwindcss/vite"];
    devDependencies.tailwindcss = versions["tailwindcss"];
  }

  return `${JSON.stringify(
    {
      dependencies: {
        [adapter.packageName]: versions[adapter.packageName],
        "@pracht/core": versions["@pracht/core"],
      },
      devDependencies,
      name: projectName,
      private: true,
      scripts,
      type: "module",
      version: "0.0.0",
    },
    null,
    2,
  )}\n`;
}

function createViteConfig(adapter, router, tailwind) {
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

function createRoutesFile() {
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

function createShellFile(projectName, tailwind = false) {
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

function createHomeRoute(adapter) {
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

function createNotFoundRoute() {
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

function createPagesHomeRoute(adapter) {
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

function createBaseTSConfig(_adapter) {
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

function createHealthRoute(adapter) {
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

function createWranglerConfig(projectName) {
  const compatibilityDate = WRANGLER_COMPATIBILITY_DATE;

  return [
    "{",
    '  "$schema": "node_modules/wrangler/config-schema.json",',
    `  "name": ${JSON.stringify(projectName)},`,
    // `pracht build` writes this thin wrapper next to server.js. It re-exports
    // only the default handler and any Worker entrypoint classes: workerd
    // validates every named export of the deployed entry module and rejects the
    // build metadata (buildTarget, manifests, ...) server.js also exports.
    '  "main": "dist/server/worker.js",',
    `  "compatibility_date": ${JSON.stringify(compatibilityDate)},`,
    '  "assets": {',
    '    "binding": "ASSETS",',
    '    "directory": "dist/client",',
    // The assets binding defaults to redirecting a prerendered route to its
    // trailing-slash form, so `GET /about` would answer 307 on Cloudflare
    // where Node and Vercel answer 200 — for the same app, and for every URL
    // the generated llms.txt advertises. Drop the slash instead so one
    // canonical form works across adapters.
    '    "html_handling": "drop-trailing-slash",',
    '    "run_worker_first": true',
    "  }",
    "}",
    "",
  ].join("\n");
}

function createNetlifyConfig(packageManager) {
  const buildCommand =
    packageManager === "npm" || packageManager === "bun"
      ? `${packageManager} run build`
      : `${packageManager} build`;

  return [
    "[build]",
    `  command = ${JSON.stringify(buildCommand)}`,
    '  publish = "dist/client"',
    "",
    "[functions]",
    '  directory = "netlify/functions"',
    "",
  ].join("\n");
}

function createCloudflareEnvDeclaration() {
  return [
    'import "@pracht/core";',
    'declare module "@pracht/core" {',
    "  interface Register {",
    "    context: {",
    "      env: Env;",
    "      executionContext: ExecutionContext;",
    "    };",
    "  }",
    "}",
    "",
  ].join("\n");
}

function createDockerfile(packageManager) {
  const COMMANDS = {
    npm: {
      build: "npm run build",
      install: "npm install",
      lockfile: "package-lock.json*",
      prune: "npm prune --omit=dev",
      setup: null,
    },
    pnpm: {
      build: "pnpm build",
      install: "pnpm install",
      lockfile: "pnpm-lock.yaml*",
      prune: "pnpm prune --prod",
      setup: "corepack enable pnpm",
    },
    yarn: {
      build: "yarn build",
      install: "yarn install",
      lockfile: "yarn.lock*",
      prune: "yarn install --production --ignore-scripts --prefer-offline",
      setup: "corepack enable yarn",
    },
  };

  // The runtime image ships Node.js, so bun scaffolds fall back to npm inside Docker.
  const commands = COMMANDS[packageManager] ?? COMMANDS.npm;

  const lines = ["# syntax=docker/dockerfile:1", "", "FROM node:22-alpine AS base", "WORKDIR /app"];

  if (commands.setup) {
    lines.push(`RUN ${commands.setup}`);
  }

  lines.push(
    "",
    "FROM base AS deps",
    `COPY package.json ${commands.lockfile} ./`,
    `RUN ${commands.install}`,
    "",
    "FROM deps AS build",
    "COPY . .",
    `RUN ${commands.build}`,
    `RUN ${commands.prune}`,
    "",
    "FROM node:22-alpine AS runtime",
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    "ENV PORT=3000",
    "COPY --from=build /app/package.json ./package.json",
    "COPY --from=build /app/node_modules ./node_modules",
    "COPY --from=build /app/dist ./dist",
    "EXPOSE 3000",
    'CMD ["node", "dist/server/server.js"]',
    "",
  );

  return lines.join("\n");
}

function createDockerignore() {
  return [
    "node_modules",
    "dist",
    ".git",
    ".env*",
    "!.env.example",
    "Dockerfile",
    ".dockerignore",
    "",
  ].join("\n");
}

const PAGES_ROUTER_LIMITATIONS =
  "**The pages router has no manifest**, so these manifest-only features are unavailable: named shells (there is one, `_app.tsx`), route middleware, capabilities (and therefore capability HTTP endpoints, WebMCP, remote MCP, and `pracht eval`), `defineApp({ constraints })`, and `agents`. If the app needs auth policy or a runtime agent surface, eject with `generateRoutesFile` from `@pracht/vite-plugin/pages-router`, remove `pagesDir`, and customize the generated manifest.";

const PAGES_ROUTER_ISG_POLICY =
  'Pages-router ISG supports time revalidation only: pair `export const RENDER_MODE = "isg"` with a positive integer such as `export const REVALIDATE = 3600`. Missing or misplaced policies fail `pracht build`, `doctor`, and `verify`. Webhook revalidation and combined policies require an explicit manifest.';

function createAgentInstructions({ adapter, agentTools, packageManager, router, tailwind }) {
  // `bun build` is Bun's own bundler and shadows the package script, so bun
  // needs the explicit `run` form the same way npm does.
  const runCmd =
    packageManager === "npm" || packageManager === "bun" ? `${packageManager} run` : packageManager;

  const lines = [
    "# Pracht App",
    "",
    "## Commands",
    "",
    `- \`${runCmd} dev\` — start the dev server`,
    `- \`${runCmd} build\` — production build`,
  ];

  if (adapter.id === "node" || adapter.id === "cloudflare" || adapter.id === "netlify") {
    lines.push(`- \`${runCmd} preview\` — build and serve the production build locally`);
  }

  if (adapter.id === "node") {
    lines.push(`- \`${runCmd} start\` — run the built server`);
  }

  if (adapter.id === "cloudflare" || adapter.id === "netlify" || adapter.id === "vercel") {
    lines.push(`- \`${runCmd} deploy\` — build and deploy`);
  }

  lines.push("");
  lines.push("## Scaffolding");
  lines.push("");
  lines.push("Use the CLI to generate new files:");
  lines.push("");
  lines.push("- `pracht generate route --path /about` — add a route");
  if (router !== "pages") {
    lines.push("- `pracht generate shell --name app` — add a shell");
    lines.push("- `pracht generate middleware --name auth` — add middleware");
  }
  lines.push("- `pracht generate api --path /health --methods GET` — add an API route");
  if (router !== "pages") {
    lines.push(
      "- `pracht generate capability --name notes.search --effect read --expose http` — add a capability (agent-callable operation)",
    );
  }
  lines.push("- `pracht doctor` — check project health");
  lines.push("- `pracht verify` — enforce route and constraint invariants");
  lines.push(
    "- `pracht plan --write` — refresh the committed `.pracht/app-graph.json` snapshot after route changes",
  );
  lines.push("- `pracht report` — PR-ready markdown summary (plan diff, verify, budgets)");
  lines.push("- `pracht llms --write` — write an `llms.txt` authoring guide for coding agents");

  lines.push("");
  lines.push("## Project structure");
  lines.push("");

  if (router === "pages") {
    lines.push("This app uses **pages routing** (file-system based).");
    lines.push("");
    lines.push("- `src/pages/` — file-system routes (each file becomes a route)");
    lines.push("- `src/pages/_app.tsx` — app shell (layout and head)");
    lines.push(
      "- `src/pages/404.tsx` — not-found page, wired automatically (never a URL of its own)",
    );
    lines.push("");
    lines.push(PAGES_ROUTER_LIMITATIONS);
    lines.push("");
    lines.push(PAGES_ROUTER_ISG_POLICY);
  } else {
    lines.push("This app uses **manifest routing**.");
    lines.push("");
    lines.push("- `src/routes.ts` — route manifest (defines all routes and shells)");
    lines.push("- `src/routes/` — route components and loaders");
    lines.push(
      "- `src/routes/not-found.tsx` — not-found page, wired via `notFound` in the manifest",
    );
    lines.push("- `src/shells/` — shell components (layouts)");
  }

  lines.push("- `src/api/` — API route handlers");
  lines.push(`- \`vite.config.ts\` — Vite config with the ${adapter.label} adapter`);

  if (tailwind) {
    lines.push("- `src/styles/global.css` — Tailwind CSS entry stylesheet, imported by the shell");
  }

  if (adapter.id === "node") {
    lines.push("- `Dockerfile` — multi-stage container build that runs the built server");
  }

  if (adapter.id === "cloudflare") {
    lines.push("- `wrangler.jsonc` — Cloudflare Workers configuration");
    lines.push("- `src/env.d.ts` — TypeScript types for Cloudflare bindings");
  }

  if (adapter.id === "netlify") {
    lines.push("- `netlify.toml` — Netlify build, publish, and functions configuration");
  }

  if (agentTools) {
    lines.push("");
    lines.push("## Agent tooling");
    lines.push("");
    lines.push(
      "- `.claude/skills/` — pracht Claude Code skills (audits, scaffolds, testing, debugging); invoke with `/<skill-name>`",
    );
    lines.push(
      "- `.mcp.json` — registers the `pracht mcp` server so MCP clients can inspect the app graph, run doctor/verify, and scaffold natively",
    );
  }

  lines.push("");

  return lines.join("\n");
}

function createReadme({
  adapter,
  agentTools,
  packageManager,
  pnpmMajor,
  pnpmWorkspaceNotice,
  projectName,
  router,
  tailwind,
}) {
  const installCommand = packageManager === "npm" ? "npm install" : `${packageManager} install`;
  const devCommand = packageManager === "npm" ? "npm run dev" : `${packageManager} dev`;
  // `bun build` is Bun's own bundler and shadows the package script, unlike
  // `bun dev` / `bun start` / `bun preview`, which fall through to it.
  const buildCommand =
    packageManager === "npm" || packageManager === "bun"
      ? `${packageManager} run build`
      : `${packageManager} build`;
  const previewCommand = packageManager === "npm" ? "npm run preview" : `${packageManager} preview`;
  const startCommand = packageManager === "npm" ? "npm run start" : `${packageManager} start`;
  const deployCommand = packageManager === "npm" ? "npm run deploy" : `${packageManager} deploy`;
  const typecheckCommand =
    packageManager === "npm" ? "npm run typecheck" : `${packageManager} typecheck`;

  const lines = [
    `# ${projectName}`,
    "",
    `This pracht starter is configured for ${adapter.label}.`,
    "",
    "## Commands",
    "",
    `- \`${installCommand}\``,
    `- \`${devCommand}\``,
    `- \`${buildCommand}\``,
    `- \`${typecheckCommand}\``,
  ];

  if (adapter.id === "node") {
    lines.push(`- \`${previewCommand}\``);
    lines.push(`- \`${startCommand}\``);
  }

  if (adapter.id === "cloudflare") {
    lines.push(`- \`${previewCommand}\``);
    lines.push(`- \`${deployCommand}\``);
    lines.push("");
    lines.push(
      "Edit `wrangler.jsonc` to add KV, D1, R2, cron triggers, or other Cloudflare bindings.",
    );
  }

  if (adapter.id === "netlify") {
    lines.push(`- \`${previewCommand}\``);
    lines.push(`- \`${deployCommand}\``);
    lines.push("");
    lines.push(
      "`netlify.toml` publishes `dist/client` and discovers the Pracht function generated during the build.",
    );
  }

  if (adapter.id === "vercel") {
    lines.push(`- \`${deployCommand}\``);
    lines.push("");
    lines.push("Run the deploy command after linking or logging into your Vercel account.");
  }

  lines.push("");
  lines.push("## Files");
  lines.push("");

  if (router === "pages") {
    lines.push("- `src/pages/` contains your file-system routes.");
    lines.push("- `src/pages/_app.tsx` is the app shell.");
    lines.push("- `src/pages/index.tsx` is the home page.");
    lines.push("- `src/pages/404.tsx` is the not-found page; pracht wires it automatically.");
    lines.push("");
    lines.push("## Pages-router boundaries");
    lines.push("");
    lines.push(PAGES_ROUTER_LIMITATIONS);
    lines.push("");
    lines.push(PAGES_ROUTER_ISG_POLICY);
  } else {
    lines.push("- `src/routes.ts` defines your app manifest.");
    lines.push("- `src/routes/home.tsx` is the first page.");
    lines.push("- `src/routes/not-found.tsx` is the not-found page, wired via `notFound`.");
  }

  lines.push("- `src/api/health.ts` is a sample API route.");

  if (packageManager === "pnpm") {
    lines.push(
      pnpmWorkspaceNotice
        ? `- The containing pnpm workspace owns build-script policy. Add the listed dependencies to its \`${pnpmWorkspaceNotice.policy}\` block; no nested \`pnpm-workspace.yaml\` is generated.`
        : pnpmMajor <= 10
          ? "- `pnpm-workspace.yaml#onlyBuiltDependencies` allows only the dependency build scripts required by this starter."
          : "- `pnpm-workspace.yaml#allowBuilds` allows only the dependency build scripts required by this starter.",
    );
  }

  if (tailwind) {
    lines.push("- `src/styles/global.css` is the Tailwind CSS entry, imported by the shell.");
  }

  if (agentTools) {
    lines.push(
      "- `.claude/skills/` and `.mcp.json` wire up the pracht Claude Code skills and MCP server.",
    );
  }

  lines.push("");
  lines.push("## Checks");
  lines.push("");
  lines.push(
    router === "pages"
      ? "- `pracht verify` validates routes."
      : "- `pracht verify` validates routes and constraints.",
  );
  lines.push(
    "- `pracht plan --write` commits an app-graph snapshot to `.pracht/`; `pracht plan` diffs against it.",
  );
  lines.push("- `pracht report` prints a PR-ready summary of both.");

  if (adapter.id === "node") {
    lines.push("");
    lines.push("## Docker");
    lines.push("");
    lines.push("A multi-stage `Dockerfile` builds the app and runs the Node server:");
    lines.push("");
    lines.push("```bash");
    lines.push(`docker build -t ${projectName} .`);
    lines.push(`docker run -p 3000:3000 ${projectName}`);
    lines.push("```");
  }

  return `${lines.join("\n")}\n`;
}

export function toPackageName(value) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || DEFAULT_DIRECTORY;
}
