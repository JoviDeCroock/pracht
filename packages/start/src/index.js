import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 2;
  }
}

const FALLBACK_VERSION_RANGES = {
  "@pracht/adapter-cloudflare": "^0.2.2",
  "@pracht/adapter-node": "^0.1.11",
  "@pracht/adapter-vercel": "^0.0.13",
  "@pracht/cli": "^1.3.1",
  "@pracht/core": "^0.5.0",
  "@pracht/vite-plugin": "^0.3.2",
  vercel: "latest",
};

async function fetchLatestVersion(packageName) {
  const res = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
  if (!res.ok) {
    throw new Error(`Failed to fetch version for ${packageName}: ${res.statusText}`);
  }
  const data = await res.json();
  return data.version;
}

const ADAPTERS = {
  node: {
    description: "Node.js server with a generated server entry",
    id: "node",
    label: "Node.js",
    packageName: "@pracht/adapter-node",
    short: "node",
  },
  cloudflare: {
    description: "Cloudflare Workers with wrangler deploy",
    id: "cloudflare",
    label: "Cloudflare Workers",
    packageName: "@pracht/adapter-cloudflare",
    short: "cf",
  },
  vercel: {
    description: "Vercel Edge Functions with prebuilt deploy",
    id: "vercel",
    label: "Vercel",
    packageName: "@pracht/adapter-vercel",
    short: "vercel",
  },
};

const DEFAULT_DIRECTORY = "pracht-app";

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const packageManager = getPackageManager();
  const log = options.json ? () => {} : console.log.bind(console);

  log("create-pracht");
  log(`Using ${packageManager} for this scaffold.`);
  log("");

  const dir = options.dir ?? (options.yes ? DEFAULT_DIRECTORY : null);
  const adapterId = options.adapter ?? (options.yes ? "node" : null);
  const router = options.router ?? (options.yes ? "manifest" : null);

  let resolvedDir = dir;
  let resolvedAdapter = adapterId;
  let resolvedRouter = router;

  if (resolvedDir == null || resolvedAdapter == null || resolvedRouter == null) {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      resolvedDir = resolvedDir ?? (await promptForDirectory(readline));
      resolvedAdapter = resolvedAdapter ?? (await promptForAdapter(readline));
      resolvedRouter = resolvedRouter ?? (await promptForRouter(readline));
    } finally {
      readline.close();
    }
  }

  const targetDir = resolve(process.cwd(), resolvedDir);

  await ensureTargetDirectory(targetDir);

  if (options.dryRun) {
    const files = await buildProjectFiles({
      adapter: ADAPTERS[resolvedAdapter],
      packageManager,
      projectName: toPackageName(basename(targetDir)),
      resolveRemoteVersions: false,
      router: resolvedRouter,
    });

    const fileList = Object.keys(files).sort();

    if (options.json) {
      console.log(
        JSON.stringify({
          adapter: resolvedAdapter,
          directory: resolvedDir,
          dryRun: true,
          files: fileList,
          router: resolvedRouter,
        }),
      );
    } else {
      log("Dry run — the following files would be created:");
      log("");
      for (const file of fileList) {
        log(`  ${file}`);
      }
    }

    return;
  }

  await scaffoldProject({
    adapter: ADAPTERS[resolvedAdapter],
    packageManager,
    router: resolvedRouter,
    targetDir,
  });

  let installSucceeded = false;
  if (!options.skipInstall) {
    log("");
    log(`Installing dependencies with ${packageManager}...`);
    installSucceeded = await installDependencies(targetDir, packageManager);
  }

  if (options.json) {
    const files = await buildProjectFiles({
      adapter: ADAPTERS[resolvedAdapter],
      packageManager,
      projectName: toPackageName(basename(targetDir)),
      resolveRemoteVersions: false,
      router: resolvedRouter,
    });

    console.log(
      JSON.stringify({
        adapter: resolvedAdapter,
        directory: resolvedDir,
        files: Object.keys(files).sort(),
        installed: options.skipInstall ? false : installSucceeded,
        router: resolvedRouter,
      }),
    );
  } else {
    printNextSteps({
      adapter: ADAPTERS[resolvedAdapter],
      dir: resolvedDir,
      installSucceeded,
      packageManager,
      skipInstall: options.skipInstall,
    });
  }
}

export async function scaffoldProject({ adapter, packageManager, router = "manifest", targetDir }) {
  const packageName = toPackageName(basename(targetDir));
  const files = await buildProjectFiles({
    adapter,
    packageManager,
    projectName: packageName,
    router,
  });

  await mkdir(targetDir, { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = resolve(targetDir, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
  }

  try {
    await symlink("AGENTS.md", resolve(targetDir, "CLAUDE.md"));
  } catch (error) {
    if (error && typeof error === "object" && ["EPERM", "EINVAL"].includes(error.code)) {
      await copyFile(resolve(targetDir, "AGENTS.md"), resolve(targetDir, "CLAUDE.md"));
    } else {
      throw error;
    }
  }
}

export function getPackageManager(userAgent = process.env.npm_config_user_agent ?? "") {
  if (userAgent.startsWith("pnpm")) return "pnpm";
  if (userAgent.startsWith("yarn")) return "yarn";
  if (userAgent.startsWith("bun") || process.versions.bun) return "bun";
  return "npm";
}

export function parseArgs(argv) {
  const options = {
    adapter: undefined,
    dir: undefined,
    dryRun: false,
    json: false,
    router: undefined,
    skipInstall: false,
    yes: false,
  };

  for (const arg of argv) {
    if (arg === "--skip-install") {
      options.skipInstall = true;
      continue;
    }

    if (arg === "--yes" || arg === "-y") {
      options.yes = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg.startsWith("--adapter=")) {
      const value = normalizeAdapter(arg.slice("--adapter=".length));
      if (!value) {
        throw new ValidationError(
          `Invalid adapter: ${arg.slice("--adapter=".length)}. Use node, cf, or vercel.`,
        );
      }
      options.adapter = value;
      continue;
    }

    if (arg.startsWith("--router=")) {
      const value = normalizeRouter(arg.slice("--router=".length));
      if (!value) {
        throw new ValidationError(
          `Invalid router: ${arg.slice("--router=".length)}. Use manifest or pages.`,
        );
      }
      options.router = value;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (!arg.startsWith("-") && !options.dir) {
      options.dir = arg;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function promptForDirectory(readline) {
  while (true) {
    const answer = await readline.question(`Project directory (${DEFAULT_DIRECTORY}): `);
    const dir = answer.trim() || DEFAULT_DIRECTORY;
    const targetDir = resolve(process.cwd(), dir);
    const error = await validateTargetDirectory(targetDir);

    if (!error) {
      return dir;
    }

    console.log(error);
  }
}

async function promptForAdapter(readline) {
  console.log("Adapters:");
  console.log("  1. Node.js");
  console.log("  2. Cloudflare Workers");
  console.log("  3. Vercel");

  while (true) {
    const answer = await readline.question("Adapter (1): ");
    const normalized = normalizeAdapter(answer.trim() || "1");

    if (normalized) {
      return normalized;
    }

    console.log("Choose 1/2/3 or node/cf/vercel.");
  }
}

async function promptForRouter(readline) {
  console.log("Router:");
  console.log("  1. Manifest (explicit routes.ts)");
  console.log("  2. Pages (file-system routing)");

  while (true) {
    const answer = await readline.question("Router (1): ");
    const normalized = normalizeRouter(answer.trim() || "1");

    if (normalized) {
      return normalized;
    }

    console.log("Choose 1/2 or manifest/pages.");
  }
}

async function ensureTargetDirectory(targetDir) {
  const error = await validateTargetDirectory(targetDir);

  if (error) {
    throw new ValidationError(error);
  }
}

async function validateTargetDirectory(targetDir) {
  if (!existsSync(targetDir)) {
    return null;
  }

  const targetStat = await stat(targetDir);
  if (!targetStat.isDirectory()) {
    return "Target path already exists and is not a directory.";
  }

  const entries = await readdir(targetDir);
  if (entries.length > 0) {
    return "Target directory already exists and is not empty.";
  }

  return null;
}

function normalizeRouter(value) {
  const normalized = value.toLowerCase();

  if (normalized === "1" || normalized === "manifest") {
    return "manifest";
  }

  if (normalized === "2" || normalized === "pages") {
    return "pages";
  }

  return null;
}

function normalizeAdapter(value) {
  const normalized = value.toLowerCase();

  if (normalized === "1" || normalized === "node") {
    return "node";
  }

  if (
    normalized === "2" ||
    normalized === "cf" ||
    normalized === "cloudflare" ||
    normalized === "cloudflare-workers"
  ) {
    return "cloudflare";
  }

  if (normalized === "3" || normalized === "vc" || normalized === "vercel") {
    return "vercel";
  }

  return null;
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

async function buildProjectFiles({
  adapter,
  packageManager,
  projectName,
  resolveRemoteVersions = true,
  router,
}) {
  const packagesToResolve = [
    "@pracht/cli",
    "@pracht/vite-plugin",
    "@pracht/core",
    adapter.packageName,
  ];
  if (adapter.id === "vercel") {
    packagesToResolve.push("vercel");
  }

  const versions = await resolveVersions(packagesToResolve, { remote: resolveRemoteVersions });

  const files = {
    ".gitignore": "dist\nnode_modules\n.wrangler\n.vercel\n",
    "README.md": createReadme({ adapter, packageManager, projectName, router }),
    "package.json": createPackageJson({ adapter, projectName, versions }),
    "src/api/health.ts": createHealthRoute(adapter),
    "vite.config.ts": createViteConfig(adapter, router),
    "tsconfig.json": createBaseTSConfig(adapter),
    "AGENTS.md": createAgentInstructions({ adapter, packageManager, router }),
  };

  if (router === "pages") {
    files["src/pages/_app.tsx"] = createShellFile(projectName);
    files["src/pages/index.tsx"] = createPagesHomeRoute(adapter);
  } else {
    files["src/routes.ts"] = createRoutesFile();
    files["src/routes/home.tsx"] = createHomeRoute(adapter);
    files["src/shells/public.tsx"] = createShellFile(projectName);
  }

  if (adapter.id === "cloudflare") {
    files["wrangler.jsonc"] = createWranglerConfig(projectName);
    files["src/env.d.ts"] = createCloudflareEnvDeclaration();
  }

  return files;
}

function createPackageJson({ adapter, projectName, versions }) {
  const scripts = {
    build: "pracht build",
    dev: "pracht dev",
  };

  if (adapter.id === "node") {
    scripts.start = "node dist/server/server.js";
  }

  const devDependencies = {
    "@pracht/cli": versions["@pracht/cli"],
    "@pracht/vite-plugin": versions["@pracht/vite-plugin"],
    preact: "^10.26.9",
    "preact-render-to-string": "^6.5.13",
    vite: "^8.0.0",
  };

  if (adapter.id === "cloudflare") {
    scripts.deploy = "pracht build && wrangler deploy";
    devDependencies.wrangler = "^4.81.0";
  }

  if (adapter.id === "vercel") {
    scripts.deploy = "pracht build && vercel deploy --prebuilt";
    devDependencies.vercel = versions["vercel"];
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

function createViteConfig(adapter, router) {
  const ADAPTER_IMPORTS = {
    node: { fn: "nodeAdapter", pkg: "@pracht/adapter-node" },
    cloudflare: { fn: "cloudflareAdapter", pkg: "@pracht/adapter-cloudflare" },
    vercel: { fn: "vercelAdapter", pkg: "@pracht/adapter-vercel" },
  };

  const info = ADAPTER_IMPORTS[adapter.id] ?? ADAPTER_IMPORTS.node;

  const prachtOptions =
    router === "pages"
      ? `{ pagesDir: "/src/pages", adapter: ${info.fn}() }`
      : `{ adapter: ${info.fn}() }`;

  return [
    'import { defineConfig } from "vite";',
    'import { pracht } from "@pracht/vite-plugin";',
    `import { ${info.fn} } from "${info.pkg}";`,
    "",
    "export default defineConfig({",
    `  plugins: [pracht(${prachtOptions})],`,
    "});",
    "",
  ].join("\n");
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
    "});",
    "",
  ].join("\n");
}

function createShellFile(projectName) {
  return [
    'import type { ShellProps } from "@pracht/core";',
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
  const compatibilityDate = new Date().toISOString().slice(0, 10);

  return [
    "{",
    '  "$schema": "node_modules/wrangler/config-schema.json",',
    `  "name": ${JSON.stringify(projectName)},`,
    '  "main": "dist/server/server.js",',
    `  "compatibility_date": ${JSON.stringify(compatibilityDate)},`,
    '  "assets": {',
    '    "binding": "ASSETS",',
    '    "directory": "dist/client",',
    '    "run_worker_first": true',
    "  }",
    "}",
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

function createAgentInstructions({ adapter, packageManager, router }) {
  const runCmd = packageManager === "npm" ? "npm run" : packageManager;

  const lines = [
    "# Pracht App",
    "",
    "## Commands",
    "",
    `- \`${runCmd} dev\` — start the dev server`,
    `- \`${runCmd} build\` — production build`,
  ];

  if (adapter.id === "node") {
    lines.push(`- \`${runCmd} start\` — run the built server`);
  }

  if (adapter.id === "cloudflare" || adapter.id === "vercel") {
    lines.push(`- \`${runCmd} deploy\` — build and deploy`);
  }

  lines.push("");
  lines.push("## Scaffolding");
  lines.push("");
  lines.push("Use the CLI to generate new files:");
  lines.push("");
  lines.push("- `pracht generate route --path /about` — add a route");
  lines.push("- `pracht generate shell --name app` — add a shell");
  lines.push("- `pracht generate middleware --name auth` — add middleware");
  lines.push("- `pracht generate api --path /health --methods GET` — add an API route");
  lines.push("- `pracht doctor` — check project health");

  lines.push("");
  lines.push("## Project structure");
  lines.push("");

  if (router === "pages") {
    lines.push("This app uses **pages routing** (file-system based).");
    lines.push("");
    lines.push("- `src/pages/` — file-system routes (each file becomes a route)");
    lines.push("- `src/pages/_app.tsx` — app shell (layout and head)");
  } else {
    lines.push("This app uses **manifest routing**.");
    lines.push("");
    lines.push("- `src/routes.ts` — route manifest (defines all routes and shells)");
    lines.push("- `src/routes/` — route components and loaders");
    lines.push("- `src/shells/` — shell components (layouts)");
  }

  lines.push("- `src/api/` — API route handlers");
  lines.push(`- \`vite.config.ts\` — Vite config with the ${adapter.label} adapter`);

  if (adapter.id === "cloudflare") {
    lines.push("- `wrangler.jsonc` — Cloudflare Workers configuration");
    lines.push("- `src/env.d.ts` — TypeScript types for Cloudflare bindings");
  }

  lines.push("");

  return lines.join("\n");
}

function createReadme({ adapter, packageManager, projectName, router }) {
  const installCommand = packageManager === "npm" ? "npm install" : `${packageManager} install`;
  const devCommand = packageManager === "npm" ? "npm run dev" : `${packageManager} dev`;
  const startCommand = packageManager === "npm" ? "npm run start" : `${packageManager} start`;
  const deployCommand = packageManager === "npm" ? "npm run deploy" : `${packageManager} deploy`;

  const lines = [
    `# ${projectName}`,
    "",
    `This pracht starter is configured for ${adapter.label}.`,
    "",
    "## Commands",
    "",
    `- \`${installCommand}\``,
    `- \`${devCommand}\``,
  ];

  if (adapter.id === "node") {
    lines.push(`- \`${startCommand}\``);
  }

  if (adapter.id === "cloudflare") {
    lines.push(`- \`${deployCommand}\``);
    lines.push("");
    lines.push(
      "Edit `wrangler.jsonc` to add KV, D1, R2, cron triggers, or other Cloudflare bindings.",
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
  } else {
    lines.push("- `src/routes.ts` defines your app manifest.");
    lines.push("- `src/routes/home.tsx` is the first page.");
  }

  lines.push("- `src/api/health.ts` is a sample API route.");

  return `${lines.join("\n")}\n`;
}

async function installDependencies(targetDir, packageManager) {
  const args = packageManager === "yarn" ? ["install"] : ["install"];

  return await new Promise((resolveInstall) => {
    const child = spawn(packageManager, args, {
      cwd: targetDir,
      stdio: "inherit",
    });

    child.on("close", (code) => {
      resolveInstall(code === 0);
    });

    child.on("error", () => {
      resolveInstall(false);
    });
  });
}

function printNextSteps({ adapter, dir, installSucceeded, packageManager, skipInstall }) {
  const installCommand = packageManager === "npm" ? "npm install" : `${packageManager} install`;
  const devCommand = packageManager === "npm" ? "npm run dev" : `${packageManager} dev`;

  console.log("");
  console.log(`Created a pracht app in ${dir}.`);
  console.log(`Adapter: ${adapter.label}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  cd ${dir}`);

  if (skipInstall || !installSucceeded) {
    console.log(`  ${installCommand}`);
  }

  console.log(`  ${devCommand}`);

  if (!skipInstall && !installSucceeded) {
    console.log("");
    console.log("Dependency installation did not complete. The project files were still created.");
  }
}

function printHelp() {
  console.log(`create-pracht

Usage:
  create-pracht [directory] [options]

Options:
  --adapter=node|cf|vercel   Choose hosting adapter (default: node)
  --router=manifest|pages    Choose routing system (default: manifest)
  --skip-install             Skip dependency installation
  --yes, -y                  Accept defaults, skip all prompts
  --json                     Output JSON summary instead of prose
  --dry-run                  Show which files would be created without writing
  -h, --help                 Show this help message
`);
}

function toPackageName(value) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || DEFAULT_DIRECTORY;
}
