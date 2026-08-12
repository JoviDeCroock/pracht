const PAGES_ROUTER_LIMITATIONS =
  "**The pages router has no manifest**, so these manifest-only features are unavailable: named shells (there is one, `_app.tsx`), route middleware, capabilities (and therefore capability HTTP endpoints, WebMCP, remote MCP, and `pracht eval`), `defineApp({ constraints })`, and `agents`. If the app needs auth policy or a runtime agent surface, eject with `generateRoutesFile` from `@pracht/vite-plugin/pages-router`, remove `pagesDir`, and customize the generated manifest.";

const PAGES_ROUTER_ISG_POLICY =
  'Pages-router ISG supports time revalidation only: pair `export const RENDER_MODE = "isg"` with a positive integer such as `export const REVALIDATE = 3600`. Missing or misplaced policies fail `pracht build`, `doctor`, and `verify`. Webhook revalidation and combined policies require an explicit manifest.';

export function createAgentInstructions({ adapter, agentTools, packageManager, router, tailwind }) {
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

export function createReadme({
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
