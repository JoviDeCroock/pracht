// Helpers shared by the registry-style install checks: scripts/pack-smoke.mjs
// (a fresh app on the packed packages) and scripts/pack-upgrade.mjs (an app on
// the published packages, upgraded to the packed ones).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const packagesRoot = resolve(repoRoot, "packages");

export const ADAPTERS = {
  node: { factory: "nodeAdapter", pkg: "@pracht/adapter-node" },
  static: { factory: "staticAdapter", pkg: "@pracht/adapter-static" },
  vercel: { factory: "vercelAdapter", pkg: "@pracht/adapter-vercel" },
  netlify: { factory: "netlifyAdapter", pkg: "@pracht/adapter-netlify" },
  cloudflare: { factory: "cloudflareAdapter", pkg: "@pracht/adapter-cloudflare" },
};

/** What a successful `pracht build` writes for each adapter. */
export const BUILD_OUTPUT = {
  node: "dist/server/server.js",
  static: "dist/client/index.html",
  vercel: ".vercel/output/config.json",
  netlify: "netlify/functions/pracht.mjs",
  cloudflare: "dist/server/wrangler.json",
};

// Deploy CLIs the scaffold adds as devDependencies. `pracht build` never calls
// them, and netlify-cli alone is most of the install time.
export const DEPLOY_ONLY_DEV_DEPENDENCIES = ["netlify-cli", "vercel"];

/** `--adapter=a,b` (repeatable) from argv, validated; every adapter when none is given. */
export function requestedAdapters(args, label) {
  const requested = args
    .filter((arg) => arg.startsWith("--adapter="))
    .flatMap((arg) => arg.slice("--adapter=".length).split(","))
    .filter(Boolean);
  const unknown = requested.filter((id) => !ADAPTERS[id]);
  if (unknown.length > 0) {
    console.error(
      `${label}: unknown adapter "${unknown[0]}"; use ${Object.keys(ADAPTERS).join(", ")}`,
    );
    process.exit(1);
  }
  return requested.length > 0 ? requested : Object.keys(ADAPTERS);
}

// A child pnpm/npm must not inherit the settings of a `pnpm run` that started
// this script — they describe the workspace, not the app under test.
export const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^npm_(config|package|lifecycle)_/i.test(key) && key !== "PNPM_SCRIPT_SRC_DIR",
  ),
);

export class SmokeFailure extends Error {}

export function fail(message) {
  throw new SmokeFailure(message);
}

export function step(message) {
  console.log(`\n▸ ${message}`);
}

export function run(command, commandArgs, { cwd, env = {} } = {}) {
  console.log(`$ ${command} ${commandArgs.join(" ")}  (in ${cwd})`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: { ...baseEnv, ...env },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    console.error(output);
    fail(`\`${command} ${commandArgs.join(" ")}\` exited with ${result.status ?? result.signal}`);
  }
  return output;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function tarballName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

function publicPackages() {
  const packages = [];
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    const manifestPath = join(packagesRoot, entry.name, "package.json");
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    if (manifest.private) continue;
    packages.push({
      dir: join(packagesRoot, entry.name),
      name: manifest.name,
      version: manifest.version,
    });
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/** Fail unless `pnpm build` has run: packing does not build. */
export function assertWorkspaceBuilt() {
  for (const required of ["framework/dist", "cli/dist", "vite-plugin/dist"]) {
    if (!existsSync(join(packagesRoot, required)))
      fail(`packages/${required} is missing; run \`pnpm build\` first`);
  }
}

/**
 * `pnpm pack` every public package under packages/ into `tarballDir` (so
 * `workspace:` ranges are rewritten exactly as on publish). Returns the
 * tarball path per package name.
 */
export function packWorkspace(tarballDir) {
  const packages = publicPackages();
  for (const pkg of packages) {
    run("pnpm", ["pack", "--pack-destination", tarballDir], { cwd: pkg.dir });
  }
  const tarballs = {};
  for (const pkg of packages) {
    const file = join(tarballDir, tarballName(pkg.name, pkg.version));
    if (!existsSync(file)) fail(`expected ${file} after packing ${pkg.name}`);
    tarballs[pkg.name] = file;
  }
  console.log(`packed ${packages.length} packages into ${tarballDir}`);
  return tarballs;
}

/**
 * Configure the app's install. With `storeDir`, lay it out strictly:
 * `hoist: false` and a virtual store outside its node_modules (the layout of
 * pnpm's global virtual store), so a published file resolves only what its
 * own package.json declares. With `tarballs`, every `@pracht/*` dependency
 * (direct and transitive, through `overrides`) points at the packed workspace
 * instead of the registry.
 */
export function configureAppInstall(appDir, { storeDir = null, tarballs = null } = {}) {
  const manifestPath = join(appDir, "package.json");
  const manifest = readJson(manifestPath);
  if (tarballs) {
    for (const field of ["dependencies", "devDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (tarballs[name]) manifest[field][name] = `file:${tarballs[name]}`;
      }
    }
  }
  for (const name of DEPLOY_ONLY_DEV_DEPENDENCIES) delete manifest.devDependencies?.[name];
  writeJson(manifestPath, manifest);

  const workspaceYaml = join(appDir, "pnpm-workspace.yaml");
  if (!existsSync(workspaceYaml)) fail(`${appDir}: scaffold wrote no pnpm-workspace.yaml`);
  const marker = "# pracht install check";
  const scaffolded = readFileSync(workspaceYaml, "utf-8").split(marker)[0].trimEnd();
  const overrides = tarballs
    ? [
        "overrides:",
        ...Object.keys(tarballs).map(
          (name) => `  ${JSON.stringify(name)}: ${JSON.stringify(`file:${tarballs[name]}`)}`,
        ),
      ]
    : [];
  writeFileSync(
    workspaceYaml,
    [
      scaffolded,
      marker,
      ...(storeDir ? ["hoist: false", `virtualStoreDir: ${JSON.stringify(storeDir)}`] : []),
      ...overrides,
      "",
    ].join("\n"),
  );
  return manifest;
}

export function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** `GET /` answers 200 with an HTML document. */
export const PAGE_CHECK = {
  path: "/",
  async verify(response) {
    const body = await response.text();
    if (response.status !== 200) throw new Error(`GET / returned ${response.status}`);
    if (!/<html/i.test(body)) throw new Error("GET / did not return an HTML document");
    return `GET / → 200 (${body.length} bytes)`;
  },
};

/**
 * Start `node <entry>` in `cwd` and run each check against it, retrying the
 * first until the server is up.
 */
export async function smokeNodeServer(
  cwd,
  label,
  { entry = "dist/server/server.js", checks = [PAGE_CHECK] } = {},
) {
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...baseEnv, NODE_ENV: "production", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  const request = (check) =>
    fetch(`http://127.0.0.1:${port}${check.path}`, { headers: check.headers ?? {} });

  try {
    const [first, ...rest] = checks;
    const deadline = Date.now() + 30_000;
    let lastError;
    let up = false;
    while (Date.now() < deadline && !up) {
      if (child.exitCode !== null) break;
      try {
        console.log(`${label}: ${await first.verify(await request(first))}`);
        up = true;
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!up) {
      console.error(log);
      fail(
        `${label}: server never served ${first.path} (${lastError?.message ?? "process exited"})`,
      );
    }
    for (const check of rest) {
      try {
        console.log(`${label}: ${await check.verify(await request(check))}`);
      } catch (error) {
        console.error(log);
        fail(`${label}: ${error.message}`);
      }
    }
  } finally {
    child.kill();
    await exited;
  }
}

export function assertOutsideRepo(path, label) {
  const real = realpathSync(path);
  if (real === repoRoot || real.startsWith(repoRoot + sep)) {
    fail(`${label} resolved into the workspace (${real}); the install is not registry-style`);
  }
}
