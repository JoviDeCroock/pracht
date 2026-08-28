import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 2;
  }
}

const FALLBACK_VERSION_RANGES = {
  "@pracht/adapter-cloudflare": "^0.5.8",
  "@pracht/adapter-netlify": "^0.1.0",
  "@pracht/adapter-node": "^0.3.8",
  "@pracht/adapter-static": "^0.1.0",
  "@pracht/adapter-vercel": "^0.2.8",
  "@pracht/cli": "^1.11.0",
  "@pracht/core": "^0.14.0",
  "@pracht/vite-plugin": "^0.9.0",
  "@tailwindcss/vite": "^4.1.0",
  "netlify-cli": "^21.6.0",
  tailwindcss: "^4.1.0",
  typescript: "^6.0.0",
  vercel: "^56.5.0",
};

/**
 * Cloudflare `compatibility_date` for scaffolded apps.
 *
 * This has to be a date the installed workerd already knows about — workerd
 * refuses to start when asked for a date newer than the one its binary was
 * built with ("This Worker requires compatibility date X, but the newest date
 * supported by this server binary is Y"). Using today's date is therefore
 * always wrong: it is, by construction, at or beyond the newest released
 * workerd, so a freshly scaffolded app could not run `wrangler dev` on the day
 * it was created.
 *
 * Keep it at or below the ceiling of the oldest wrangler this scaffold accepts
 * (see `devDependencies.wrangler` below). That ceiling is *not* the workerd
 * version date — it usually runs a little ahead of it — so check it rather
 * than infer it: install that wrangler and start a worker with a candidate
 * date; the error message names the newest date the binary supports.
 *
 * `packages/start/test/index.test.js` fails once this drifts too far behind, so
 * a new app never silently opts out of years of default-on runtime behaviour.
 */
const WRANGLER_COMPATIBILITY_DATE = "2026-04-06";

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
  netlify: {
    description: "Netlify Functions with durable CDN caching",
    id: "netlify",
    label: "Netlify",
    packageName: "@pracht/adapter-netlify",
    short: "netlify",
  },
  vercel: {
    description: "Vercel Edge Functions with prebuilt deploy",
    id: "vercel",
    label: "Vercel",
    packageName: "@pracht/adapter-vercel",
    short: "vercel",
  },
  static: {
    description: "Pure static export — deploy dist/client to any static host",
    id: "static",
    label: "Static export",
    packageName: "@pracht/adapter-static",
    short: "static",
  },
};

const DEFAULT_DIRECTORY = "pracht-app";

function readFileSyncSafe(path) {
  return readFileSync(path, "utf-8");
}

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

// The published package bundles a copy of the repo skills (see
// scripts/sync-skills.js); inside the monorepo we fall back to the source.
const SKILL_DIRS = [resolve(PACKAGE_ROOT, "skills"), resolve(PACKAGE_ROOT, "../../skills")];

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const packageManagerUserAgent = process.env.npm_config_user_agent ?? "";
  const packageManager = getPackageManager(packageManagerUserAgent);
  const pnpmMajor = packageManager === "pnpm" ? getPnpmMajor(packageManagerUserAgent) : null;
  const log = options.json ? () => {} : console.log.bind(console);

  log("create-pracht");
  log(`Using ${packageManager} for this scaffold.`);
  log("");

  const dir = options.dir ?? (options.yes ? DEFAULT_DIRECTORY : null);
  const adapterId = options.adapter ?? (options.yes ? "node" : null);
  const router = options.router ?? (options.yes ? "manifest" : null);
  const tailwind = options.tailwind ?? (options.yes ? false : null);
  const agentTools = options.agentTools ?? (options.yes ? true : null);

  let resolvedDir = dir;
  let resolvedAdapter = adapterId;
  let resolvedRouter = router;
  let resolvedTailwind = tailwind;
  let resolvedAgentTools = agentTools;

  if (
    resolvedDir == null ||
    resolvedAdapter == null ||
    resolvedRouter == null ||
    resolvedTailwind == null ||
    resolvedAgentTools == null
  ) {
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      resolvedDir = resolvedDir ?? (await promptForDirectory(readline));
      resolvedAdapter = resolvedAdapter ?? (await promptForAdapter(readline));
      resolvedRouter = resolvedRouter ?? (await promptForRouter(readline));
      resolvedTailwind = resolvedTailwind ?? (await promptForTailwind(readline));
      resolvedAgentTools = resolvedAgentTools ?? (await promptForAgentTools(readline));
    } finally {
      readline.close();
    }
  }

  const targetDir = resolve(process.cwd(), resolvedDir);

  await ensureTargetDirectory(targetDir);

  if (options.dryRun) {
    const { files } = await buildProjectFiles({
      adapter: ADAPTERS[resolvedAdapter],
      agentTools: resolvedAgentTools,
      packageManager,
      pnpmMajor,
      projectName: toPackageName(basename(targetDir)),
      resolveRemoteVersions: false,
      router: resolvedRouter,
      tailwind: resolvedTailwind,
      targetDir,
    });

    const fileList = Object.keys(files).sort();

    if (options.json) {
      console.log(
        JSON.stringify({
          adapter: resolvedAdapter,
          agentTools: resolvedAgentTools,
          directory: resolvedDir,
          dryRun: true,
          files: fileList,
          router: resolvedRouter,
          tailwind: resolvedTailwind,
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

  const { pnpmWorkspaceNotice } = await scaffoldProject({
    adapter: ADAPTERS[resolvedAdapter],
    agentTools: resolvedAgentTools,
    packageManager,
    pnpmMajor,
    router: resolvedRouter,
    tailwind: resolvedTailwind,
    targetDir,
  });

  let installSucceeded = false;
  if (!options.skipInstall) {
    log("");
    log(`Installing dependencies with ${packageManager}...`);
    installSucceeded = await installDependencies(targetDir, packageManager);
  }

  let gitInitialized = false;
  if (options.git) {
    const gitResult = await initGitRepository(targetDir);
    gitInitialized = gitResult.initialized;

    if (gitResult.initialized) {
      log("");
      log("Initialized a git repository with an initial commit.");
    } else if (gitResult.reason === "existing-repo") {
      log("");
      log("Skipped git init — the target directory is already inside a git repository.");
    } else if (gitResult.reason === "git-not-found") {
      log("");
      log("Skipped git init — git is not available on this machine.");
    }
  }

  if (options.json) {
    const { files } = await buildProjectFiles({
      adapter: ADAPTERS[resolvedAdapter],
      agentTools: resolvedAgentTools,
      packageManager,
      pnpmMajor,
      projectName: toPackageName(basename(targetDir)),
      resolveRemoteVersions: false,
      router: resolvedRouter,
      tailwind: resolvedTailwind,
      targetDir,
    });

    console.log(
      JSON.stringify({
        adapter: resolvedAdapter,
        agentTools: resolvedAgentTools,
        directory: resolvedDir,
        files: Object.keys(files).sort(),
        gitInitialized,
        installed: options.skipInstall ? false : installSucceeded,
        // The automation path has to carry this too: an instruction printed to
        // a terminal nobody reads is an instruction nobody applies, and the
        // consequence is a Cloudflare app with no workerd binary.
        pnpmWorkspaceNotice,
        router: resolvedRouter,
        tailwind: resolvedTailwind,
      }),
    );
  } else {
    printNextSteps({
      adapter: ADAPTERS[resolvedAdapter],
      agentTools: resolvedAgentTools,
      dir: resolvedDir,
      installSucceeded,
      packageManager,
      pnpmWorkspaceNotice,
      router: resolvedRouter,
      skipInstall: options.skipInstall,
      tailwind: resolvedTailwind,
    });
  }
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

export function getPackageManager(userAgent = process.env.npm_config_user_agent ?? "") {
  if (userAgent.startsWith("pnpm")) return "pnpm";
  if (userAgent.startsWith("yarn")) return "yarn";
  if (userAgent.startsWith("bun") || process.versions.bun) return "bun";
  return "npm";
}

export function getPnpmMajor(userAgent = process.env.npm_config_user_agent ?? "") {
  const match = /^pnpm\/(\d+)/.exec(userAgent);
  return match ? Number(match[1]) : 11;
}

export function parseArgs(argv) {
  const options = {
    adapter: undefined,
    agentTools: undefined,
    dir: undefined,
    dryRun: false,
    git: true,
    json: false,
    router: undefined,
    skipInstall: false,
    tailwind: undefined,
    yes: false,
  };

  for (const arg of argv) {
    if (arg === "--skip-install") {
      options.skipInstall = true;
      continue;
    }

    if (arg === "--tailwind") {
      options.tailwind = true;
      continue;
    }

    if (arg === "--no-tailwind") {
      options.tailwind = false;
      continue;
    }

    if (arg === "--no-git") {
      options.git = false;
      continue;
    }

    if (arg === "--agent-tools") {
      options.agentTools = true;
      continue;
    }

    if (arg === "--no-agent-tools") {
      options.agentTools = false;
      continue;
    }

    if (arg.startsWith("--template=")) {
      const value = normalizeTemplate(arg.slice("--template=".length));
      if (!value) {
        throw new ValidationError(
          `Invalid template: ${arg.slice("--template=".length)}. Use minimal or tailwind.`,
        );
      }
      options.tailwind = value === "tailwind";
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
          `Invalid adapter: ${arg.slice("--adapter=".length)}. Use node, cf, netlify, vercel, or static.`,
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
  console.log("  4. Netlify");
  console.log("  5. Static export (no server)");

  while (true) {
    const answer = await readline.question("Adapter (1): ");
    const normalized = normalizeAdapter(answer.trim() || "1");

    if (normalized) {
      return normalized;
    }

    console.log("Choose 1/2/3/4/5 or node/cf/vercel/netlify/static.");
  }
}

async function promptForRouter(readline) {
  // The two routers are not equivalent, and the difference is invisible until
  // you reach for a manifest-only feature. Say so at the point of choosing.
  console.log("Router:");
  console.log("  1. Manifest (explicit routes.ts) — supports middleware, capabilities,");
  console.log("     MCP, Web Bot Auth, and constraints");
  console.log("  2. Pages (file-system routing) — pages and API routes only; no");
  console.log("     middleware, capabilities, MCP, or agent trust (eject later to add them)");

  while (true) {
    const answer = await readline.question("Router (1): ");
    const normalized = normalizeRouter(answer.trim() || "1");

    if (normalized) {
      return normalized;
    }

    console.log("Choose 1/2 or manifest/pages.");
  }
}

async function promptForTailwind(readline) {
  while (true) {
    const answer = await readline.question("Use Tailwind CSS? (y/N): ");
    const normalized = normalizeYesNo(answer.trim() || "no");

    if (normalized != null) {
      return normalized;
    }

    console.log("Answer y/yes or n/no.");
  }
}

async function promptForAgentTools(readline) {
  while (true) {
    const answer = await readline.question("Set up Claude Code skills + MCP? (Y/n): ");
    const normalized = normalizeYesNo(answer.trim() || "yes");

    if (normalized != null) {
      return normalized;
    }

    console.log("Answer y/yes or n/no.");
  }
}

function normalizeYesNo(value) {
  const normalized = value.toLowerCase();

  if (normalized === "y" || normalized === "yes") {
    return true;
  }

  if (normalized === "n" || normalized === "no") {
    return false;
  }

  return null;
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

function normalizeTemplate(value) {
  const normalized = value.toLowerCase();

  if (normalized === "minimal") {
    return "minimal";
  }

  if (normalized === "tailwind") {
    return "tailwind";
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

  if (normalized === "4" || normalized === "nf" || normalized === "netlify") {
    return "netlify";
  }

  if (normalized === "5" || normalized === "static" || normalized === "export") {
    return "static";
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
    "vite.config.ts": createViteConfig(adapter, router, tailwind),
    "tsconfig.json": createBaseTSConfig(adapter),
  };

  // A static export has no server, so an API route would be a hard build
  // error — the starter must not scaffold one it cannot build.
  if (adapter.id !== "static") {
    files["src/api/health.ts"] = createHealthRoute(adapter);
  }

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

  if (adapter.id === "static") {
    scripts.preview = "pracht preview";
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
    static: { fn: "staticAdapter", pkg: "@pracht/adapter-static" },
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
    adapter.id === "static"
      ? '      "Fetch live data from the browser — a static export runs no server.",'
      : '      "Add API handlers in src/api/*.ts.",',
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
    adapter.id === "static"
      ? "        Run <code>pracht build</code>, then deploy <code>dist/client</code> anywhere."
      : "        Check <code>/api/health</code> for a simple API route.",
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
    adapter.id === "static"
      ? '      "Fetch live data from the browser — a static export runs no server.",'
      : '      "Add API handlers in src/api/*.ts.",',
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
    adapter.id === "static"
      ? "        Run <code>pracht build</code>, then deploy <code>dist/client</code> anywhere."
      : "        Check <code>/api/health</code> for a simple API route.",
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
      types: ["vite/client", "@pracht/vite-plugin/virtual"],
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

/**
 * pnpm blocks dependency install scripts unless they are allowlisted, and
 * esbuild and workerd both need theirs — workerd's postinstall downloads the
 * runtime binary, so without this `wrangler dev` fails right after scaffolding
 * with `ERR_PNPM_IGNORED_BUILDS`.
 *
 * This has to live in `pnpm-workspace.yaml`: pnpm 10 uses
 * `onlyBuiltDependencies`, while pnpm 11 uses `allowBuilds` and no longer reads
 * the `pnpm` field in package.json. npm and yarn ignore this file entirely, so
 * it is inert for them. (npm has its own `allow-scripts` prompt, which it
 * drives interactively.)
 */
function pnpmBuildAllowlist(adapter, tailwind) {
  const packages = ["esbuild"];
  if (adapter.id === "cloudflare") packages.push("workerd");
  if (tailwind) packages.push("@tailwindcss/oxide");
  return packages.sort();
}

function pnpmBuildPolicyName(pnpmMajor) {
  return pnpmMajor <= 10 ? "onlyBuiltDependencies" : "allowBuilds";
}

function createPnpmWorkspaceConfig(adapter, tailwind, pnpmMajor) {
  const policy = pnpmBuildPolicyName(pnpmMajor);
  const entries = pnpmBuildAllowlist(adapter, tailwind);

  return [
    "packages:",
    '  - "."',
    `${policy}:`,
    ...(policy === "onlyBuiltDependencies"
      ? entries.map((name) => `  - ${JSON.stringify(name)}`)
      : entries.map((name) => `  ${JSON.stringify(name)}: true`)),
    "",
  ].join("\n");
}

/**
 * Nearest ancestor `pnpm-workspace.yaml` above `dir`, or null.
 *
 * pnpm resolves settings from the workspace *root*, so writing our own file
 * inside an existing monorepo would be read by nobody — while also re-rooting
 * the workspace for anyone who runs `pnpm install` from the app directory,
 * which detaches it from its siblings.
 */
function findAncestorPnpmWorkspace(dir) {
  let current = resolve(dir, "..");
  for (;;) {
    const configPath = resolve(current, "pnpm-workspace.yaml");
    // An ancestor config only governs this app if its `packages:` globs cover
    // it. Suppressing our own file for a workspace the app is *not* a member of
    // leaves it with no install at all: pnpm re-roots to the ancestor and
    // installs that workspace's projects instead.
    if (existsSync(configPath) && workspaceCovers(configPath, current, dir)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Whether `dir` matches one of the `packages:` globs in a pnpm workspace
 * config. A deliberately small YAML reader: the block and flow list forms pnpm
 * accepts, and `*` / `**` globs.
 *
 * Both failure directions matter, and they are not symmetric. Deciding "not a
 * member" for a directory that *is* one writes a nested `pnpm-workspace.yaml`
 * that re-roots the workspace at the app; deciding "member" for one that is
 * not only prints instructions. So anything this reader cannot confidently
 * decide answers `true`.
 */
function workspaceCovers(configPath, workspaceRoot, dir) {
  let contents;
  try {
    contents = readFileSyncSafe(configPath);
  } catch {
    return true;
  }

  const globs = [];
  let sawPackagesKey = false;
  let inBlockList = false;

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.replace(/#.*$/, "");
    const packagesKey = line.match(/^packages\s*:(.*)$/);
    if (packagesKey) {
      sawPackagesKey = true;
      // Flow form: `packages: ["apps/*", "tools/*"]`, which pnpm accepts.
      const flow = packagesKey[1].trim();
      if (flow.startsWith("[")) {
        for (const entry of flow.replace(/^\[|\]$/g, "").split(",")) {
          const value = entry.trim().replace(/^["']|["']$/g, "");
          if (value) globs.push(value);
        }
        inBlockList = false;
      } else {
        inBlockList = true;
      }
      continue;
    }
    if (inBlockList) {
      const item = line.match(/^\s+-\s*["']?([^"'\s]+)["']?\s*$/);
      if (item) {
        globs.push(item[1]);
        continue;
      }
      if (line.trim() !== "") inBlockList = false;
    }
  }

  // No `packages:` key at all is a single-package workspace rooted there,
  // which does not cover a nested app. A key we could not read is a decision
  // we cannot make — fall to "member".
  if (!sawPackagesKey) return false;
  if (globs.length === 0) return true;

  const relative = resolve(dir)
    .slice(resolve(workspaceRoot).length + 1)
    .split(/[\\/]/);
  // A negation (`!apps/legacy`) narrows the set; treat its presence as
  // undecidable rather than as an ordinary glob.
  if (globs.some((glob) => glob.startsWith("!"))) return true;
  // pnpm treats a workspace-root-relative `./apps/*` the same as `apps/*`.
  // Strip only that harmless prefix before comparing path segments.
  const normalizedGlobs = globs.map((glob) => glob.replace(/^(?:\.\/)+/, ""));
  // pnpm accepts the wider glob syntax supported by its workspace matcher.
  // This intentionally small matcher cannot safely decide braces, character
  // classes, extglobs, or single-character wildcards. Follow the conservative
  // contract above instead of creating a nested workspace for a real member.
  if (normalizedGlobs.some((glob) => /[?[\]{}()]/.test(glob))) return true;
  return normalizedGlobs.some((glob) => matchesGlobSegments(glob.split("/"), relative));
}

/**
 * Segment-wise glob match. `**` matches the rest; otherwise a segment may
 * contain `*` wildcards (`app-*`), which pnpm supports.
 */
function matchesGlobSegments(globSegments, pathSegments) {
  return matchGlobSegmentAt(globSegments, pathSegments, 0, 0);
}

function matchGlobSegmentAt(globSegments, pathSegments, globIndex, pathIndex) {
  if (globIndex === globSegments.length) return pathIndex === pathSegments.length;

  const segment = globSegments[globIndex];
  if (segment === "**") {
    if (globIndex === globSegments.length - 1) return true;
    for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex += 1) {
      if (matchGlobSegmentAt(globSegments, pathSegments, globIndex + 1, nextPathIndex)) return true;
    }
    return false;
  }

  return (
    pathIndex < pathSegments.length &&
    segmentMatches(segment, pathSegments[pathIndex]) &&
    matchGlobSegmentAt(globSegments, pathSegments, globIndex + 1, pathIndex + 1)
  );
}

function segmentMatches(glob, value) {
  if (glob === "*") return true;
  if (!glob.includes("*")) return glob === value;
  const pattern = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(value);
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
    // Pracht's Vite build is the authoritative bundle and may contain lazy
    // server chunks. A second Wrangler bundle would inline them again; the
    // module rule makes Wrangler upload those chunks next to the entry.
    '  "no_bundle": true,',
    '  "rules": [{ "type": "ESModule", "globs": ["**/*.js", "**/*.mjs"] }],',
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
  // The pages router derives route ids from filenames, so the home page of a
  // pages app is `index` (`src/pages/index.tsx`); the manifest scaffold names
  // it `home` explicitly. Every id in the instructions below has to be one the
  // scaffold actually generated, or the first link an agent writes is the very
  // compile error these conventions exist to prevent.
  const homeRouteId = router === "pages" ? "index" : "home";

  const lines = [
    "# Pracht App",
    "",
    "## Commands",
    "",
    `- \`${runCmd} dev\` — start the dev server`,
    `- \`${runCmd} build\` — production build`,
  ];

  if (
    adapter.id === "node" ||
    adapter.id === "cloudflare" ||
    adapter.id === "netlify" ||
    adapter.id === "static"
  ) {
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
    if (adapter.id !== "static") {
      lines.push("- `pracht generate middleware --name auth` — add middleware");
    }
  }
  if (adapter.id !== "static") {
    lines.push("- `pracht generate api --path /health --methods GET` — add an API route");
  }
  if (router !== "pages" && adapter.id !== "static") {
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

  if (adapter.id !== "static") {
    lines.push("- `src/api/` — API route handlers");
  }
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

  lines.push("");
  lines.push("## Conventions");
  lines.push("");
  lines.push(
    `- Navigate by route id, not by path: \`<Link route="${homeRouteId}">\`, ` +
      `\`href("${homeRouteId}")\`, \`navigate({ route: "${homeRouteId}" })\`. Dynamic routes take ` +
      "their segments through `params`. `<Link href>` is a type error — the id survives a path " +
      "change and `pracht typegen` types both the id and its params. Use a plain `<a href>` for " +
      "external and user-provided URLs.",
  );
  lines.push(
    "- Run `pracht typegen` once to type route ids, params, and `apiFetch()`; `pracht dev` keeps " +
      "them in sync.",
  );

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
  // The pages router derives route ids from filenames, so its home page is
  // "index" where the manifest starter names it "home".
  const homeRouteId = router === "pages" ? "index" : "home";

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

  if (adapter.id === "static") {
    lines.push(`- \`${previewCommand}\``);
    lines.push("");
    lines.push(
      "`pracht build` writes the whole site to `dist/client`. Upload that directory to any " +
        "static host — there is no server to run. Configure the host to serve `index.html` " +
        "for directory URLs and to use `404.html` as its error document.",
    );
    lines.push("");
    lines.push(
      "A static export runs no server, so API routes, middleware, and `ssr`/`isg` routes are " +
        "build errors. Fetch live data from the browser instead, or switch to a serverful adapter.",
    );
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

  if (adapter.id !== "static") {
    lines.push("- `src/api/health.ts` is a sample API route.");
  }

  // The one convention a new app trips over before it writes anything else,
  // and AGENTS.md — where the same note lives for coding agents — is only
  // seeded when agent tooling is enabled.
  lines.push("");
  lines.push("## Navigating");
  lines.push("");
  lines.push(
    `Pracht navigates by route id, not by path: \`<Link route="${homeRouteId}">\`, ` +
      `\`href("${homeRouteId}")\`, \`navigate({ route: "${homeRouteId}" })\`. Dynamic routes ` +
      "take their segments through `params`. The id survives a path change, and `pracht " +
      "typegen` types both the id and its params — so `<Link href>` is a compile error. Use a " +
      "plain `<a href>` for external and user-provided URLs.",
  );

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

export async function initGitRepository(targetDir) {
  if (!(await execCommand("git", ["--version"]))) {
    return { initialized: false, reason: "git-not-found" };
  }

  if (await execCommand("git", ["rev-parse", "--is-inside-work-tree"], targetDir)) {
    return { initialized: false, reason: "existing-repo" };
  }

  if (!(await execCommand("git", ["init"], targetDir))) {
    return { initialized: false, reason: "init-failed" };
  }

  if (!(await execCommand("git", ["add", "-A"], targetDir))) {
    return { initialized: false, reason: "commit-failed" };
  }

  // Fall back to a scoped identity when the user has no git identity configured,
  // so the initial commit still succeeds (e.g. on fresh machines or CI).
  const hasIdentity = await execCommand("git", ["config", "user.email"], targetDir);
  const identityArgs = hasIdentity
    ? []
    : ["-c", "user.name=create-pracht", "-c", "user.email=create-pracht@localhost"];

  const committed = await execCommand(
    "git",
    [...identityArgs, "commit", "-m", "Initial commit from create-pracht"],
    targetDir,
  );

  if (!committed) {
    return { initialized: false, reason: "commit-failed" };
  }

  return { initialized: true };
}

function execCommand(command, args, cwd) {
  return new Promise((resolveExec) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "ignore",
    });

    child.on("close", (code) => {
      resolveExec(code === 0);
    });

    child.on("error", () => {
      resolveExec(false);
    });
  });
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

function printNextSteps({
  adapter,
  agentTools,
  dir,
  installSucceeded,
  packageManager,
  pnpmWorkspaceNotice,
  router,
  skipInstall,
  tailwind,
}) {
  const installCommand = packageManager === "npm" ? "npm install" : `${packageManager} install`;
  const devCommand = packageManager === "npm" ? "npm run dev" : `${packageManager} dev`;

  console.log("");
  console.log(`Created a pracht app in ${dir}.`);
  console.log(`Adapter: ${adapter.label}`);
  console.log(
    `Router:  ${router === "pages" ? "pages (file-system)" : "manifest (src/routes.ts)"}`,
  );
  console.log(`Tailwind: ${tailwind ? "yes" : "no"}`);
  console.log(`Agent tooling: ${agentTools ? "skills, .mcp.json, AGENTS.md" : "none"}`);
  if (router === "pages") {
    console.log("");
    console.log(
      "Note: the pages router has no manifest, so middleware, capabilities, constraints, and\n" +
        "the agent surface (capability endpoints, WebMCP, remote MCP, `pracht eval`) are not\n" +
        "available. Scaffold with --router=manifest if you need them.",
    );
  }
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

  if (pnpmWorkspaceNotice) {
    console.log("");
    console.log(
      `This app is inside the pnpm workspace at ${pnpmWorkspaceNotice.root}, which owns build\n` +
        "permissions for every package. Add the following to its pnpm-workspace.yaml, or\n" +
        "the starter's required dependency install scripts will not run:",
    );
    console.log("");
    console.log(`  ${pnpmWorkspaceNotice.policy}:`);
    for (const name of pnpmWorkspaceNotice.packages) {
      console.log(
        pnpmWorkspaceNotice.policy === "onlyBuiltDependencies"
          ? `    - ${JSON.stringify(name)}`
          : `    ${JSON.stringify(name)}: true`,
      );
    }
  }
}

function printHelp() {
  console.log(`create-pracht

Usage:
  create-pracht [directory] [options]

Options:
  --adapter=node|cf|netlify|vercel|static
                               Choose hosting adapter (default: node)
  --router=manifest|pages      Choose routing system (default: manifest)
  --template=minimal|tailwind  Choose starter template (minimal, or minimal + Tailwind CSS)
  --tailwind / --no-tailwind   Enable or disable Tailwind CSS wiring (default: prompt).
                               Sets the same thing as --template; the last one wins.
  --agent-tools / --no-agent-tools
                               Seed Claude Code skills and a pracht MCP config (default: prompt, yes)
  --no-git                     Skip git init and the initial commit
  --skip-install               Skip dependency installation
  --yes, -y                    Accept defaults, skip all prompts
  --json                       Output JSON summary instead of prose
  --dry-run                    Show which files would be created without writing
  -h, --help                   Show this help message
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
