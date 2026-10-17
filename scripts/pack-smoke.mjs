// Registry-style install smoke test.
//
// Every app in this repo resolves `@pracht/*` through workspace links and the
// root tsconfig `paths`, so a package that imports something it never declared,
// or that forgets a file in `files`, still works here and only breaks after it
// is published. This script installs the packages the way a user gets them:
//
//   1. `pnpm pack` every public package under packages/ (so `workspace:` ranges
//      are rewritten exactly as on publish).
//   2. Scaffold an app per adapter with the packed `create-pracht`, in a temp
//      directory outside the workspace.
//   3. Point every `@pracht/*` dependency (direct and transitive, via pnpm
//      `overrides`) at the tarballs and install them strictly: `hoist: false`
//      and a virtual store outside the app's node_modules (the layout of pnpm's
//      global virtual store). A published file then resolves only what its own
//      package.json declares — walking up from the store never reaches the
//      app's direct dependencies. No workspace links, no tsconfig `paths`.
//   4. Typecheck the app plus a probe that fails if an adapter's published
//      types collapse to `any`, run `pracht build`, and smoke-test the output:
//      the Node server answers an HTTP request, both from the full install and
//      from an `npm install --omit=dev` production install.
//
//   node scripts/pack-smoke.mjs                      every adapter
//   node scripts/pack-smoke.mjs --adapter=node       one adapter (repeatable)
//   node scripts/pack-smoke.mjs --keep               keep the temp directory
//
// Run `pnpm build` first; packing does not build.
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = resolve(repoRoot, "packages");

const ADAPTERS = {
  node: { factory: "nodeAdapter", pkg: "@pracht/adapter-node" },
  static: { factory: "staticAdapter", pkg: "@pracht/adapter-static" },
  vercel: { factory: "vercelAdapter", pkg: "@pracht/adapter-vercel" },
  netlify: { factory: "netlifyAdapter", pkg: "@pracht/adapter-netlify" },
  cloudflare: { factory: "cloudflareAdapter", pkg: "@pracht/adapter-cloudflare" },
};

// Deploy CLIs the scaffold adds as devDependencies. `pracht build` never calls
// them, and netlify-cli alone is most of the install time.
const DEPLOY_ONLY_DEV_DEPENDENCIES = ["netlify-cli", "vercel"];

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const requested = args
  .filter((arg) => arg.startsWith("--adapter="))
  .flatMap((arg) => arg.slice("--adapter=".length).split(","))
  .filter(Boolean);
const unknown = requested.filter((id) => !ADAPTERS[id]);
if (unknown.length > 0) {
  console.error(
    `pack-smoke: unknown adapter "${unknown[0]}"; use ${Object.keys(ADAPTERS).join(", ")}`,
  );
  process.exit(1);
}
const adapters = requested.length > 0 ? requested : Object.keys(ADAPTERS);

// A child pnpm/npm must not inherit the settings of a `pnpm run` that started
// this script — they describe the workspace, not the app under test.
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^npm_(config|package|lifecycle)_/i.test(key) && key !== "PNPM_SCRIPT_SRC_DIR",
  ),
);

class SmokeFailure extends Error {}

function fail(message) {
  throw new SmokeFailure(message);
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

function run(command, commandArgs, { cwd, env = {} } = {}) {
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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path, value) {
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

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** Start `node dist/server/server.js` in `cwd` and assert `/` renders. */
async function smokeNodeServer(cwd, label) {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/server/server.js"], {
    cwd,
    env: { ...baseEnv, NODE_ENV: "production", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));

  try {
    const deadline = Date.now() + 30_000;
    let lastError;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        const body = await response.text();
        if (response.status !== 200) throw new Error(`GET / returned ${response.status}`);
        if (!/<html/i.test(body)) throw new Error("GET / did not return an HTML document");
        console.log(`${label}: GET / → 200 (${body.length} bytes)`);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    console.error(log);
    fail(`${label}: server never served / (${lastError?.message ?? "process exited"})`);
  } finally {
    child.kill();
    await exited;
  }
}

function assertOutsideRepo(path, label) {
  const real = realpathSync(path);
  if (real === repoRoot || real.startsWith(repoRoot + sep)) {
    fail(`${label} resolved into the workspace (${real}); the install is not registry-style`);
  }
}

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "pracht-pack-smoke-")));
const tarballDir = join(tempRoot, "tarballs");
mkdirSync(tarballDir);

try {
  for (const required of ["framework/dist", "cli/dist", "vite-plugin/dist"]) {
    if (!existsSync(join(packagesRoot, required)))
      fail(`packages/${required} is missing; run \`pnpm build\` first`);
  }

  // -- 1. pack --------------------------------------------------------------
  step("Packing public packages");
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
  const tarballSpec = (name) => `file:${tarballs[name]}`;

  const startDir = join(tempRoot, "create-pracht");
  mkdirSync(startDir);
  run("tar", ["-xzf", tarballs["create-pracht"], "-C", startDir]);
  const createPracht = join(startDir, "package/bin/create-pracht.js");

  for (const adapterId of adapters) {
    const adapter = ADAPTERS[adapterId];
    const appName = `app-${adapterId}`;
    const appDir = join(tempRoot, appName);

    // -- 2. scaffold --------------------------------------------------------
    step(`[${adapterId}] Scaffolding with the packed create-pracht`);
    run(
      process.execPath,
      [
        createPracht,
        appName,
        "--yes",
        `--adapter=${adapterId}`,
        "--skip-install",
        "--no-git",
        "--no-agent-tools",
      ],
      { cwd: tempRoot, env: { npm_config_user_agent: "pnpm/11.3.0 npm/? node/v22" } },
    );

    const tsconfig = readFileSync(join(appDir, "tsconfig.json"), "utf-8");
    if (/"paths"\s*:/.test(tsconfig)) fail(`[${adapterId}] scaffold tsconfig declares "paths"`);
    const workspaceYaml = join(appDir, "pnpm-workspace.yaml");
    if (!existsSync(workspaceYaml)) fail(`[${adapterId}] scaffold wrote no pnpm-workspace.yaml`);

    // -- 3. point @pracht/* at the tarballs ---------------------------------
    const manifestPath = join(appDir, "package.json");
    const manifest = readJson(manifestPath);
    for (const field of ["dependencies", "devDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (tarballs[name]) manifest[field][name] = tarballSpec(name);
      }
    }
    for (const name of DEPLOY_ONLY_DEV_DEPENDENCIES) delete manifest.devDependencies?.[name];
    writeJson(manifestPath, manifest);
    const overrides = Object.keys(tarballs).map(
      (name) => `  ${JSON.stringify(name)}: ${JSON.stringify(tarballSpec(name))}`,
    );
    writeFileSync(
      workspaceYaml,
      [
        readFileSync(workspaceYaml, "utf-8").trimEnd(),
        "hoist: false",
        `virtualStoreDir: ${JSON.stringify(join(tempRoot, `store-${adapterId}`))}`,
        "overrides:",
        ...overrides,
        "",
      ].join("\n"),
    );

    step(`[${adapterId}] Installing (pnpm, strict layout)`);
    run("pnpm", ["install", "--no-frozen-lockfile"], { cwd: appDir });
    for (const name of ["@pracht/core", adapter.pkg, "@pracht/vite-plugin", "@pracht/cli"]) {
      assertOutsideRepo(join(appDir, "node_modules", name), `[${adapterId}] ${name}`);
    }

    // -- 4. typecheck, build, smoke ----------------------------------------
    step(`[${adapterId}] Typechecking`);
    run("pnpm", ["run", "typecheck"], { cwd: appDir });
    writeFileSync(
      join(appDir, "pack-smoke-probe.ts"),
      [
        "// Written by pracht's scripts/pack-smoke.mjs.",
        'import type { PrachtAdapter } from "@pracht/vite-plugin";',
        `import { ${adapter.factory} } from "${adapter.pkg}";`,
        "",
        "// Compiles only while the adapter's published types resolve. If they import",
        "// a package the adapter does not declare, the factory returns `any` (behind",
        "// skipLibCheck) and this directive is reported as unused.",
        "// @ts-expect-error -- an adapter is not a string",
        `export const notAString: string = ${adapter.factory}();`,
        `export const adapter: PrachtAdapter = ${adapter.factory}();`,
        "",
      ].join("\n"),
    );
    writeJson(join(appDir, "tsconfig.pack-smoke.json"), {
      extends: "./tsconfig.json",
      include: ["pack-smoke-probe.ts"],
    });
    run("pnpm", ["exec", "tsc", "--noEmit", "--project", "tsconfig.pack-smoke.json"], {
      cwd: appDir,
    });
    rmSync(join(appDir, "pack-smoke-probe.ts"));
    rmSync(join(appDir, "tsconfig.pack-smoke.json"));

    step(`[${adapterId}] Building`);
    run("pnpm", ["run", "build"], { cwd: appDir });

    if (adapterId === "node") {
      await smokeNodeServer(appDir, "[node] full install");

      // A deploy installs only production dependencies. The adapter's types
      // need @pracht/vite-plugin, but its server must not.
      step("[node] Production install (npm --omit=dev)");
      const prodDir = join(tempRoot, "app-node-prod");
      mkdirSync(prodDir);
      cpSync(join(appDir, "dist"), join(prodDir, "dist"), { recursive: true });
      writeJson(join(prodDir, "package.json"), {
        ...manifest,
        overrides: Object.fromEntries(
          Object.keys(tarballs).map((name) => [name, tarballSpec(name)]),
        ),
      });
      const npmOutput = run(
        "npm",
        ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=warn"],
        { cwd: prodDir },
      );
      const prachtWarnings = npmOutput
        .split("\n")
        .filter((line) => /warn/i.test(line) && line.includes("@pracht/"));
      if (prachtWarnings.length > 0) {
        fail(`[node] npm warned about @pracht packages:\n${prachtWarnings.join("\n")}`);
      }
      // A dependency edge from a runtime package to the build toolchain (even
      // an optional peer) keeps it in `--omit=dev` installs: ~50 MB of Vite in
      // every production image.
      for (const devOnly of ["@pracht/vite-plugin", "@pracht/cli", "vite"]) {
        if (existsSync(join(prodDir, "node_modules", devOnly))) {
          fail(`[node] a production install pulled in ${devOnly}`);
        }
      }
      await smokeNodeServer(prodDir, "[node] production install");
    } else {
      const expected = {
        static: "dist/client/index.html",
        vercel: ".vercel/output/config.json",
        netlify: "netlify/functions/pracht.mjs",
        cloudflare: "dist/server/wrangler.json",
      }[adapterId];
      if (!existsSync(join(appDir, expected)))
        fail(`[${adapterId}] build did not write ${expected}`);
      console.log(`[${adapterId}] build wrote ${expected}`);
    }
  }

  console.log(
    `\npack-smoke: ${adapters.join(", ")} installed from tarballs, typechecked, built, and served.`,
  );
} catch (error) {
  if (!(error instanceof SmokeFailure)) throw error;
  console.error(`\npack-smoke: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (keep) console.log(`pack-smoke: kept ${tempRoot}`);
  else rmSync(tempRoot, { force: true, recursive: true });
}
