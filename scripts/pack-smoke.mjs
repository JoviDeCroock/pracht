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
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ADAPTERS,
  assertOutsideRepo,
  assertWorkspaceBuilt,
  BUILD_OUTPUT,
  configureAppInstall,
  fail,
  packWorkspace,
  requestedAdapters,
  run,
  SmokeFailure,
  smokeNodeServer,
  step,
  writeJson,
} from "./pack-shared.mjs";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const adapters = requestedAdapters(args, "pack-smoke");

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "pracht-pack-smoke-")));
const tarballDir = join(tempRoot, "tarballs");
mkdirSync(tarballDir);

try {
  assertWorkspaceBuilt();

  // -- 1. pack --------------------------------------------------------------
  step("Packing public packages");
  const tarballs = packWorkspace(tarballDir);
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

    // -- 3. point @pracht/* at the tarballs ---------------------------------
    // The deploy CLIs stay: their dependencies' build scripts must be decided
    // by the scaffold's pnpm-workspace.yaml, or pnpm 11 fails the install.
    const manifest = configureAppInstall(appDir, {
      keepDeployClis: true,
      storeDir: join(tempRoot, `store-${adapterId}`),
      tarballs,
    });

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
        "// A shared config package exports an unannotated adapter; declaration",
        "// emit must be able to name its type from the adapter package alone.",
        `export const inferred = ${adapter.factory}();`,
        `export function wrapped() { return ${adapter.factory}(); }`,
        "",
      ].join("\n"),
    );
    writeJson(join(appDir, "tsconfig.pack-smoke.json"), {
      extends: "./tsconfig.json",
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: "pack-smoke-out",
      },
      include: ["pack-smoke-probe.ts"],
    });
    run("pnpm", ["exec", "tsc", "--project", "tsconfig.pack-smoke.json"], { cwd: appDir });
    rmSync(join(appDir, "pack-smoke-out"), { force: true, recursive: true });
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
      const expected = BUILD_OUTPUT[adapterId];
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
