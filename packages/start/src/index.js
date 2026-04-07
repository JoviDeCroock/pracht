import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const ADAPTERS = {
  node: {
    description: "Node.js server with previte preview",
    id: "node",
    label: "Node.js",
    packageName: "@previte/adapter-node",
    short: "node",
  },
  cloudflare: {
    description: "Cloudflare Workers with wrangler deploy",
    id: "cloudflare",
    label: "Cloudflare Workers",
    packageName: "@previte/adapter-cloudflare",
    short: "cf",
  },
  vercel: {
    description: "Vercel Edge Functions with prebuilt deploy",
    id: "vercel",
    label: "Vercel",
    packageName: "@previte/adapter-vercel",
    short: "vercel",
  },
};

const DEFAULT_DIRECTORY = "previte-app";

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const packageManager = getPackageManager();

  console.log("create-previte");
  console.log(`Using ${packageManager} for this scaffold.`);
  console.log("");

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const dir = options.dir ?? (await promptForDirectory(readline));
    const adapterId = options.adapter ?? (await promptForAdapter(readline));
    const targetDir = resolve(process.cwd(), dir);

    await ensureTargetDirectory(targetDir);

    await scaffoldProject({
      adapter: ADAPTERS[adapterId],
      packageManager,
      targetDir,
    });

    let installSucceeded = false;
    if (!options.skipInstall) {
      console.log("");
      console.log(`Installing dependencies with ${packageManager}...`);
      installSucceeded = await installDependencies(targetDir, packageManager);
    }

    printNextSteps({
      adapter: ADAPTERS[adapterId],
      dir,
      installSucceeded,
      packageManager,
      skipInstall: options.skipInstall,
    });
  } finally {
    readline.close();
  }
}

export async function scaffoldProject({ adapter, packageManager, targetDir }) {
  const packageName = toPackageName(basename(targetDir));
  const files = buildProjectFiles({
    adapter,
    packageManager,
    projectName: packageName,
  });

  await mkdir(targetDir, { recursive: true });

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = resolve(targetDir, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
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
    skipInstall: false,
  };

  for (const arg of argv) {
    if (arg === "--skip-install") {
      options.skipInstall = true;
      continue;
    }

    if (arg.startsWith("--adapter=")) {
      options.adapter = normalizeAdapter(arg.slice("--adapter=".length));
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

async function ensureTargetDirectory(targetDir) {
  const error = await validateTargetDirectory(targetDir);

  if (error) {
    throw new Error(error);
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

function buildProjectFiles({ adapter, packageManager, projectName }) {
  const files = {
    ".gitignore": "dist\nnode_modules\n.wrangler\n.vercel\n",
    "README.md": createReadme({ adapter, packageManager, projectName }),
    "package.json": createPackageJson({ adapter, projectName }),
    "src/api/health.ts": createHealthRoute(adapter),
    "src/routes.ts": createRoutesFile(),
    "src/routes/home.tsx": createHomeRoute(adapter),
    "src/shells/public.tsx": createShellFile(projectName),
    "vite.config.ts": createViteConfig(adapter),
  };

  if (adapter.id === "cloudflare") {
    files["wrangler.jsonc"] = createWranglerConfig(projectName);
    files["src/env.d.ts"] = createCloudflareEnvDeclaration();
  }

  return files;
}

function createPackageJson({ adapter, projectName }) {
  const scripts = {
    build: "previte build",
    dev: "previte dev",
    preview: "previte preview",
  };

  const devDependencies = {
    "@previte/cli": "latest",
    "@previte/vite-plugin": "latest",
    preact: "^10.26.9",
    "preact-render-to-string": "^6.5.13",
    vite: "^8.0.0",
  };

  if (adapter.id === "cloudflare") {
    scripts.deploy = "previte build && wrangler deploy";
    devDependencies.wrangler = "^4.81.0";
  }

  if (adapter.id === "vercel") {
    scripts.deploy = "previte build && vercel deploy --prebuilt";
    devDependencies.vercel = "latest";
  }

  return `${JSON.stringify(
    {
      dependencies: {
        [adapter.packageName]: "latest",
        previte: "latest",
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

function createViteConfig(adapter) {
  const ADAPTER_IMPORTS = {
    node: { fn: "nodeAdapter", pkg: "@previte/adapter-node" },
    cloudflare: { fn: "cloudflareAdapter", pkg: "@previte/adapter-cloudflare" },
    vercel: { fn: "vercelAdapter", pkg: "@previte/adapter-vercel" },
  };

  const info = ADAPTER_IMPORTS[adapter.id] ?? ADAPTER_IMPORTS.node;

  return [
    'import { defineConfig } from "vite";',
    'import { previte } from "@previte/vite-plugin";',
    `import { ${info.fn} } from "${info.pkg}";`,
    "",
    "export default defineConfig({",
    `  plugins: [previte({ adapter: ${info.fn}() })],`,
    "});",
    "",
  ].join("\n");
}

function createRoutesFile() {
  return [
    'import { defineApp, route } from "previte";',
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
    'import type { ShellProps } from "previte";',
    "",
    "export function Shell({ children }: ShellProps) {",
    "  return (",
    '    <div style={{ fontFamily: "Inter, system-ui, sans-serif", margin: "0 auto", maxWidth: "720px", padding: "48px 20px" }}>',
    '      <header style={{ marginBottom: "32px" }}>',
    `        <strong>${projectName}</strong>`,
    '        <p style={{ color: "#555", margin: "8px 0 0" }}>A new previte app.</p>',
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
    'import type { LoaderArgs, RouteComponentProps } from "previte";',
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
    '      <h1 style={{ fontSize: "2.5rem", lineHeight: 1.1, margin: "0 0 16px" }}>Your previte app is up and running.</h1>',
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

function createHealthRoute(adapter) {
  return [
    "export function GET() {",
    "  return Response.json({",
    `    adapter: ${JSON.stringify(adapter.short)},`,
    "    ok: true,",
    '    service: "previte",',
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
    'import "previte";',
    'declare module "previte" {',
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

function createReadme({ adapter, packageManager, projectName }) {
  const installCommand = packageManager === "npm" ? "npm install" : `${packageManager} install`;
  const devCommand = packageManager === "npm" ? "npm run dev" : `${packageManager} dev`;
  const previewCommand = packageManager === "npm" ? "npm run preview" : `${packageManager} preview`;
  const deployCommand = packageManager === "npm" ? "npm run deploy" : `${packageManager} deploy`;

  const lines = [
    `# ${projectName}`,
    "",
    `This previte starter is configured for ${adapter.label}.`,
    "",
    "## Commands",
    "",
    `- \`${installCommand}\``,
    `- \`${devCommand}\``,
    `- \`${previewCommand}\``,
  ];

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
  lines.push("- `src/routes.ts` defines your app manifest.");
  lines.push("- `src/routes/home.tsx` is the first page.");
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
  console.log(`Created a previte app in ${dir}.`);
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
  console.log(`create-previte

Usage:
  create-previte [directory] [--adapter=node|cf|vercel] [--skip-install]
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
