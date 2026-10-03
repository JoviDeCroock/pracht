import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  cliPath,
  createRepoTempDir,
  runCli,
  stopChild,
  waitFor,
  writeProjectFile,
  writeTypedManifestApp,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

describe("@pracht/cli dev typegen", () => {
  it("pracht dev forwards a custom Vite cache directory", async () => {
    const appDir = createRepoTempDir("pracht-cli-dev-cache-app-");
    const cacheDir = createRepoTempDir("pracht-cli-dev-cache-data-");
    writeTypedManifestApp(appDir);

    const configPath = join(appDir, "vite.config.ts");
    writeProjectFile(
      appDir,
      "vite.config.ts",
      readFileSync(configPath, "utf-8").replace(
        "plugins: [",
        'plugins: [{ name: "cache-probe", configResolved(config) { console.log("CACHE:" + config.cacheDir); } }, ',
      ),
    );

    const child = spawn(
      process.execPath,
      [cliPath, "dev", "--port", "3986", "--cache-dir", cacheDir],
      {
        cwd: appDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    try {
      await waitFor(
        () => output.includes("CACHE:"),
        30_000,
        () => output,
      );
      expect(output).toContain(`CACHE:${cacheDir}`);
    } finally {
      await stopChild(child);
    }
  }, 120_000);

  it("pracht dev explains how to enable generated route types", async () => {
    const appDir = createRepoTempDir("pracht-cli-dev-typegen-hint-");
    writeTypedManifestApp(appDir);

    const child = spawn(process.execPath, [cliPath, "dev"], {
      cwd: appDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    try {
      await waitFor(
        () => output.includes("run `pracht typegen` once"),
        30_000,
        () => output,
      );
      expect(existsSync(join(appDir, "src/pracht.d.ts"))).toBe(false);
    } finally {
      await stopChild(child);
    }
  }, 120_000);

  it("pracht dev exposes .env values to the server process", async () => {
    // Regression guard for the call site, not just the helper: `pracht dev`
    // has to load `.env` into `process.env` before Vite starts, or an
    // unprefixed key stays invisible to loaders, middleware, API routes, and
    // `serverEnv`. The vite config is evaluated by that same process, so it is
    // the cheapest place to observe what server code would see.
    const appDir = createRepoTempDir("pracht-cli-dev-dotenv-");
    writeTypedManifestApp(appDir);
    writeProjectFile(appDir, ".env", "PRACHT_DOTENV_PROBE=from-dot-env\n");

    const configPath = join(appDir, "vite.config.ts");
    writeProjectFile(
      appDir,
      "vite.config.ts",
      `console.log("PROBE:" + process.env.PRACHT_DOTENV_PROBE);\n` +
        readFileSync(configPath, "utf-8"),
    );

    const child = spawn(process.execPath, [cliPath, "dev", "--port", "3987"], {
      cwd: appDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    try {
      await waitFor(
        () => output.includes("PROBE:"),
        30_000,
        () => output,
      );
      expect(output).toContain("PROBE:from-dot-env");
    } finally {
      await stopChild(child);
    }
  }, 120_000);

  it("pracht dev picks up .env edits without a manual restart", async () => {
    // `.env` used to be read once at startup: Vite restarted the server on the
    // edit, but `process.env` (and `serverEnv`) kept the old values. The vite
    // config is re-evaluated by that same process on the restart, so it sees
    // exactly what loaders and API routes would.
    const appDir = createRepoTempDir("pracht-cli-dev-dotenv-reload-");
    writeTypedManifestApp(appDir);
    writeProjectFile(appDir, ".env", "PRACHT_DOTENV_RELOAD=first\n");
    const configPath = join(appDir, "vite.config.ts");
    writeProjectFile(
      appDir,
      "vite.config.ts",
      `console.log("PROBE:" + process.env.PRACHT_DOTENV_RELOAD);\n` +
        readFileSync(configPath, "utf-8"),
    );

    const child = spawn(process.execPath, [cliPath, "dev", "--port", "5612"], {
      cwd: appDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    try {
      await waitFor(
        () => output.includes("PROBE:first") && output.includes("http"),
        30_000,
        () => output,
      );

      writeProjectFile(appDir, ".env", "PRACHT_DOTENV_RELOAD=second\n");
      await waitFor(
        () => output.includes("PROBE:second"),
        30_000,
        () => output,
      );

      writeProjectFile(appDir, ".env", "# emptied\n");
      await waitFor(
        () => output.includes("PROBE:undefined"),
        30_000,
        () => output,
      );
    } finally {
      await stopChild(child);
    }
  }, 120_000);

  it("pracht dev keeps generated route types in sync with route files", async () => {
    const appDir = createRepoTempDir("pracht-cli-dev-typegen-");
    writeTypedManifestApp(appDir);
    writeProjectFile(
      appDir,
      "src/routes.ts",
      `import { defineApp } from "@pracht/core";
import { routes } from "./route-definitions";

export const app = defineApp({ routes });
`,
    );
    writeProjectFile(
      appDir,
      "src/route-definitions.ts",
      `import { route } from "@pracht/core";

export const routes = [
  route("/", "./routes/home.tsx", { id: "home", render: "ssg" }),
];
`,
    );
    runCli(["typegen"], { cwd: appDir });

    const child = spawn(process.execPath, [cliPath, "dev"], {
      cwd: appDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    try {
      // The route-type watcher attaches before the banner prints.
      await waitFor(
        () => output.includes("http"),
        30_000,
        () => output,
      );

      writeProjectFile(
        appDir,
        "src/api/ping.ts",
        "export function GET() {\n  return Response.json({ pong: true });\n}\n",
      );

      await waitFor(
        () => readFileSync(join(appDir, "src/pracht.d.ts"), "utf-8").includes('"/api/ping"'),
        30_000,
        () => output,
      );

      writeProjectFile(
        appDir,
        "src/route-definitions.ts",
        `import { route } from "@pracht/core";

export const routes = [
  route("/", "./routes/home.tsx", { id: "home", render: "ssg" }),
  route("/settings", "./routes/home.tsx", { id: "settings", render: "ssr" }),
];
`,
      );

      await waitFor(
        () => readFileSync(join(appDir, "src/pracht.d.ts"), "utf-8").includes('"settings"'),
        30_000,
        () => output,
      );
    } finally {
      await stopChild(child);
    }
  }, 120_000);

  it("pracht dev keeps route types in sync across manifest-triggered restarts", async () => {
    // Every edit to src/routes.ts restarts the Vite server, which replaces its
    // file watcher. The route-type watcher used to stay bound to the first
    // server's watcher, so only the first manifest edit was ever picked up.
    const appDir = createRepoTempDir("pracht-cli-dev-typegen-restart-");
    writeTypedManifestApp(appDir);
    runCli(["typegen"], { cwd: appDir });
    const manifestPath = join(appDir, "src/routes.ts");
    const manifest = readFileSync(manifestPath, "utf-8");
    const addRoute = (id) =>
      readFileSync(manifestPath, "utf-8").replace(
        "  routes: [\n",
        `  routes: [\n    route("/${id}", "./routes/home.tsx", { id: "${id}", render: "ssr" }),\n`,
      );
    expect(manifest).toContain("  routes: [\n");

    const child = spawn(process.execPath, [cliPath, "dev", "--port", "5610"], {
      cwd: appDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const declaration = () => readFileSync(join(appDir, "src/pracht.d.ts"), "utf-8");

    try {
      await waitFor(
        () => output.includes("http"),
        30_000,
        () => output,
      );

      for (const id of ["first-edit", "second-edit", "third-edit"]) {
        const restarts = output.split("server restarted").length;
        writeProjectFile(appDir, "src/routes.ts", addRoute(id));
        await waitFor(
          () => declaration().includes(`"${id}"`),
          30_000,
          () => output,
        );
        // Let the restart this edit triggered finish before the next edit, so
        // the next one is observed by the replacement server's watcher.
        await waitFor(
          () => output.split("server restarted").length > restarts,
          30_000,
          () => output,
        );
      }

      // Adding a route source file after the restarts is still observed.
      writeProjectFile(
        appDir,
        "src/api/after-restart.ts",
        "export function GET() {\n  return Response.json({ ok: true });\n}\n",
      );
      await waitFor(
        () => declaration().includes('"/api/after-restart"'),
        30_000,
        () => output,
      );
    } finally {
      await stopChild(child);
    }
  }, 180_000);

  it("pracht dev starts syncing route types once typegen runs during the session", async () => {
    const appDir = createRepoTempDir("pracht-cli-dev-typegen-late-");
    writeTypedManifestApp(appDir);

    const child = spawn(process.execPath, [cliPath, "dev", "--port", "5611"], {
      cwd: appDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    try {
      await waitFor(
        () => output.includes("run `pracht typegen` once"),
        30_000,
        () => output,
      );
      writeProjectFile(
        appDir,
        "src/api/before.ts",
        "export function GET() {\n  return Response.json({ ok: true });\n}\n",
      );
      // A project that never ran typegen is left untouched.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(existsSync(join(appDir, "src/pracht.d.ts"))).toBe(false);

      runCli(["typegen"], { cwd: appDir });
      writeProjectFile(
        appDir,
        "src/api/after.ts",
        "export function GET() {\n  return Response.json({ ok: true });\n}\n",
      );
      await waitFor(
        () => readFileSync(join(appDir, "src/pracht.d.ts"), "utf-8").includes('"/api/after"'),
        30_000,
        () => output,
      );
    } finally {
      await stopChild(child);
    }
  }, 180_000);
});
