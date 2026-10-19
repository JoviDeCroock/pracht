// Upgrade smoke test: from the published packages to this checkout's.
//
// scripts/pack-smoke.mjs proves a *fresh* app works on the packed packages.
// This proves an *existing* one survives the upgrade:
//
//   1. Scaffold an app per adapter with the published `create-pracht`, install
//      the published `@pracht/*` packages from npm, and build it. The Node app
//      is started and smoke-tested: a page, an API route, and route state.
//   2. Point every `@pracht/*` dependency at the packed workspace tarballs
//      (through pnpm `overrides`, so transitive ones too), reinstall in place,
//      typecheck, rebuild, and smoke-test the new output the same way.
//   3. Node only: start the build output the *published* version wrote on the
//      *upgraded* runtime. Its server entry imports `@pracht/*` from
//      node_modules, so this exercises every legacy read path a runtime
//      upgrade must keep (generated-entry shape, manifests, prerendered
//      output). The other adapters bundle their runtime into the build output,
//      so an upgrade never meets an older build there.
//
//   node scripts/pack-upgrade.mjs                     every adapter
//   node scripts/pack-upgrade.mjs --adapter=node      one adapter (repeatable)
//   node scripts/pack-upgrade.mjs --from=0.7.3        published create-pracht version (default: latest)
//   node scripts/pack-upgrade.mjs --keep              keep the temp directory
//
// Run `pnpm build` first; packing does not build. Needs the npm registry.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertOutsideRepo,
  assertWorkspaceBuilt,
  BUILD_OUTPUT,
  configureAppInstall,
  fail,
  packWorkspace,
  PAGE_CHECK,
  readJson,
  requestedAdapters,
  run,
  SmokeFailure,
  smokeNodeServer,
  step,
} from "./pack-shared.mjs";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const from = args.find((arg) => arg.startsWith("--from="))?.slice("--from=".length) || "latest";
const adapters = requestedAdapters(args, "pack-upgrade");

/** The scaffold's sample API route answers JSON. */
const API_CHECK = {
  path: "/api/health",
  async verify(response) {
    const body = await response.text();
    if (response.status !== 200) throw new Error(`GET /api/health returned ${response.status}`);
    if (JSON.parse(body).ok !== true) throw new Error(`GET /api/health answered ${body}`);
    return "GET /api/health → 200 (ok: true)";
  },
};

/** A client navigation's route-state fetch answers JSON, not the HTML document. */
const ROUTE_STATE_CHECK = {
  path: "/",
  headers: { "x-pracht-route-state-request": "1" },
  async verify(response) {
    const body = await response.text();
    if (response.status !== 200) throw new Error(`route state for / returned ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("json")) throw new Error(`route state for / answered ${type || "no type"}`);
    JSON.parse(body);
    return `GET / (route state) → 200 ${type}`;
  },
};

const NODE_CHECKS = [PAGE_CHECK, API_CHECK, ROUTE_STATE_CHECK];

/** Where an older published build wrote its output, when that has moved since. */
const PUBLISHED_BUILD_OUTPUT = {
  // `dist/server/wrangler.json` is newer than @pracht/adapter-cloudflare@0.8.1.
  cloudflare: "dist/server/worker.js",
};

/** The installed version of a package, and whether it came from a packed tarball. */
function installed(appDir, name) {
  const dir = join(appDir, "node_modules", name);
  if (!existsSync(dir)) return null;
  const real = realpathSync(dir);
  return { version: readJson(join(dir, "package.json")).version, packed: real.includes("@file+") };
}

function describeInstall(appDir) {
  const names = readdirSync(join(appDir, "node_modules", "@pracht")).map((n) => `@pracht/${n}`);
  return names
    .map((name) => {
      const info = installed(appDir, name);
      return `${name}@${info.version}${info.packed ? " (packed)" : ""}`;
    })
    .join(", ");
}

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "pracht-pack-upgrade-")));
const results = [];

try {
  assertWorkspaceBuilt();

  // -- the published scaffolder ---------------------------------------------
  step(`Fetching the published create-pracht@${from}`);
  const publishedDir = join(tempRoot, "published");
  mkdirSync(publishedDir);
  run("npm", ["pack", `create-pracht@${from}`, "--silent"], { cwd: publishedDir });
  const [tarball] = readdirSync(publishedDir).filter((name) => name.endsWith(".tgz"));
  if (!tarball) fail(`npm pack create-pracht@${from} wrote no tarball`);
  run("tar", ["-xzf", tarball], { cwd: publishedDir });
  const createPracht = join(publishedDir, "package/bin/create-pracht.js");
  const publishedVersion = readJson(join(publishedDir, "package/package.json")).version;
  console.log(`create-pracht@${publishedVersion}`);

  step("Packing public packages");
  const tarballDir = join(tempRoot, "tarballs");
  mkdirSync(tarballDir);
  const tarballs = packWorkspace(tarballDir);

  for (const adapterId of adapters) {
    const appName = `app-${adapterId}`;
    const appDir = join(tempRoot, appName);
    const output = BUILD_OUTPUT[adapterId];
    const publishedOutput = PUBLISHED_BUILD_OUTPUT[adapterId] ?? output;

    // -- 1. published -------------------------------------------------------
    step(`[${adapterId}] Scaffolding with create-pracht@${publishedVersion}`);
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
    // The default pnpm layout an app has; pack-smoke checks the strict one.
    configureAppInstall(appDir);

    step(`[${adapterId}] Installing the published packages`);
    run("pnpm", ["install", "--no-frozen-lockfile"], { cwd: appDir });
    const before = installed(appDir, "@pracht/core");
    if (!before || before.packed) fail(`[${adapterId}] @pracht/core did not install from npm`);
    console.log(`[${adapterId}] ${describeInstall(appDir)}`);

    step(`[${adapterId}] Building on the published packages`);
    run("pnpm", ["run", "build"], { cwd: appDir });
    if (!existsSync(join(appDir, publishedOutput))) {
      fail(`[${adapterId}] build did not write ${publishedOutput}`);
    }
    if (adapterId === "node") {
      await smokeNodeServer(appDir, "[node] published", { checks: NODE_CHECKS });
    }
    renameSync(join(appDir, "dist"), join(appDir, "dist-published"));

    // -- 2. upgraded --------------------------------------------------------
    step(`[${adapterId}] Upgrading to the packed workspace packages`);
    configureAppInstall(appDir, { tarballs });
    run("pnpm", ["install", "--no-frozen-lockfile"], { cwd: appDir });
    for (const name of ["@pracht/core", "@pracht/cli", "@pracht/vite-plugin"]) {
      assertOutsideRepo(join(appDir, "node_modules", name), `[${adapterId}] ${name}`);
      if (!installed(appDir, name)?.packed) fail(`[${adapterId}] ${name} is not the packed one`);
    }
    console.log(`[${adapterId}] ${describeInstall(appDir)}`);

    step(`[${adapterId}] Typechecking the published scaffold on the upgraded packages`);
    run("pnpm", ["run", "typecheck"], { cwd: appDir });

    step(`[${adapterId}] Rebuilding`);
    run("pnpm", ["run", "build"], { cwd: appDir });
    if (!existsSync(join(appDir, output))) fail(`[${adapterId}] build did not write ${output}`);
    if (adapterId === "node") {
      await smokeNodeServer(appDir, "[node] upgraded", { checks: NODE_CHECKS });

      // -- 3. legacy build output on the upgraded runtime -------------------
      step("[node] Serving the published build on the upgraded runtime");
      await smokeNodeServer(appDir, "[node] published build, upgraded runtime", {
        entry: "dist-published/server/server.js",
        checks: NODE_CHECKS,
      });
    }
    results.push(
      `${adapterId}: ${before.version} → packed${adapterId === "node" ? " (+ legacy build served)" : ""}`,
    );
  }

  console.log(
    `\npack-upgrade: upgraded from create-pracht@${publishedVersion}:\n  ${results.join("\n  ")}`,
  );
} catch (error) {
  if (!(error instanceof SmokeFailure)) throw error;
  console.error(`\npack-upgrade: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (keep) console.log(`pack-upgrade: kept ${tempRoot}`);
  else rmSync(tempRoot, { force: true, recursive: true });
}
