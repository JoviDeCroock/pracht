import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(new URL("../bin/pracht.js", import.meta.url));
const repoRoot = resolve(dirname(cliPath), "../../..");
const repoTempRoot = resolve(dirname(cliPath), "../test/.tmp");
const coreImportPath = resolve(repoRoot, "packages/framework/src/index.ts");
const nodeAdapterImportPath = resolve(repoRoot, "packages/adapter-node/src/index.ts");
const vitePluginImportPath = resolve(repoRoot, "packages/vite-plugin/src/index.ts");
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("@pracht/cli", () => {
  it("reports the published package version", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(repoRoot, "packages/cli/package.json"), "utf-8"),
    );

    const env = { ...process.env };
    delete env.NODE_ENV;
    const result = spawnSync(process.execPath, [cliPath, "--version"], {
      cwd: repoRoot,
      encoding: "utf-8",
      env,
    });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`.trim()).toBe(packageJson.version);
  });

  it("scaffolds shell, middleware, route, and api modules for manifest apps", () => {
    const appDir = createTempDir("pracht-cli-manifest-");
    writeManifestApp(appDir);

    runCli(["generate", "shell", "--name", "app"], { cwd: appDir });
    runCli(["generate", "middleware", "--name", "auth"], { cwd: appDir });

    const apiResult = runCli(
      ["generate", "api", "--path", "/health", "--methods", "GET,POST", "--json"],
      { cwd: appDir },
    );
    const apiJson = JSON.parse(apiResult.stdout);

    runCli(
      [
        "generate",
        "route",
        "--path",
        "/dashboard",
        "--render",
        "isg",
        "--revalidate",
        "120",
        "--shell",
        "app",
        "--middleware",
        "auth",
        "--loader",
        "--error-boundary",
      ],
      { cwd: appDir },
    );

    const manifest = readFileSync(join(appDir, "src/routes.ts"), "utf-8");
    const shellSource = readFileSync(join(appDir, "src/shells/app.tsx"), "utf-8");
    const middlewareSource = readFileSync(join(appDir, "src/middleware/auth.ts"), "utf-8");
    const routeSource = readFileSync(join(appDir, "src/routes/dashboard.tsx"), "utf-8");
    const apiSource = readFileSync(join(appDir, "src/api/health.ts"), "utf-8");

    expect(apiJson).toMatchObject({
      created: ["src/api/health.ts"],
      kind: "api",
      ok: true,
      updated: [],
    });
    expect(shellSource).toContain("export function Shell({ children }: ShellProps)");
    expect(middlewareSource).toContain("export const middleware: MiddlewareFn");
    expect(routeSource).toContain("export async function loader(_args: LoaderArgs)");
    expect(routeSource).toContain("export function ErrorBoundary({ error }: ErrorBoundaryProps)");
    expect(apiSource).toContain("export function GET(_args: BaseRouteArgs)");
    expect(apiSource).toContain("export async function POST({ request }: BaseRouteArgs)");
    expect(manifest).toContain('import { defineApp, route, timeRevalidate } from "@pracht/core";');
    expect(manifest).toContain('shells: {\n    app: "./shells/app.tsx",\n  },');
    expect(manifest).toContain('middleware: {\n    auth: "./middleware/auth.ts",\n  },');
    expect(manifest).toContain('route("/dashboard", "./routes/dashboard.tsx", {');
    expect(manifest).toContain('shell: "app",');
    expect(manifest).toContain('middleware: ["auth"],');
    expect(manifest).toContain("revalidate: timeRevalidate(120)");
  });

  it("reports a healthy manifest app in doctor json output", () => {
    const appDir = createTempDir("pracht-cli-doctor-ok-");
    writeManifestApp(appDir, {
      routesSource: `import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  shells: {
    app: "./shells/app.tsx",
  },
  middleware: {
    auth: "./middleware/auth.ts",
  },
  routes: [route("/dashboard", "./routes/dashboard.tsx", { id: "dashboard", shell: "app", middleware: ["auth"], render: "ssr" })],
});
`,
    });

    writeProjectFile(
      appDir,
      "src/shells/app.tsx",
      `import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return <main>{children}</main>;
}
`,
    );
    writeProjectFile(
      appDir,
      "src/middleware/auth.ts",
      `import type { MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async (_args, next) => {
  return next();
};
`,
    );
    writeProjectFile(
      appDir,
      "src/routes/dashboard.tsx",
      `export function Component() {
  return <h1>Dashboard</h1>;
}
`,
    );

    const result = runCli(["doctor", "--json"], { cwd: appDir });
    const report = JSON.parse(result.stdout);

    expect(report.ok).toBe(true);
    expect(report.mode).toBe("manifest");
    expect(report.checks.some((check) => check.message.includes("app manifest"))).toBe(true);
    expect(report.checks.some((check) => check.message.includes("adapter dependency"))).toBe(true);
  });

  it("reports blocking doctor failures for broken manifest references", () => {
    const appDir = createTempDir("pracht-cli-doctor-bad-");
    writeManifestApp(appDir, {
      routesSource: `import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  routes: [route("/broken", "./routes/missing.tsx", { id: "broken", render: "ssr" })],
});
`,
    });

    const result = runCliStatus(["doctor", "--json"], { cwd: appDir });
    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => check.message.includes("missing files"))).toBe(true);
  });

  it("reports a healthy manifest app in verify json output", () => {
    const appDir = createTempDir("pracht-cli-verify-ok-");
    writeManifestApp(appDir, {
      routesSource: `import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  routes: [route("/dashboard", "./routes/dashboard.tsx", { id: "dashboard", render: "ssr" })],
});
`,
    });

    writeProjectFile(
      appDir,
      "src/routes/dashboard.tsx",
      `export function Component() {
  return <h1>Dashboard</h1>;
}
`,
    );
    writeProjectFile(
      appDir,
      "src/api/health.ts",
      `export function GET() {
  return new Response("ok");
}
`,
    );

    const result = runCli(["verify", "--json"], { cwd: appDir });
    const report = JSON.parse(result.stdout);

    expect(report.ok).toBe(true);
    expect(report.scope).toBe("full");
    expect(report.checks.some((check) => check.message.includes("manifest module path"))).toBe(
      true,
    );
    expect(report.checks.some((check) => check.message.includes("API route discovery"))).toBe(true);
  });

  it("reports duplicate API discovery failures in verify json output", () => {
    const appDir = createTempDir("pracht-cli-verify-api-dupe-");
    writeManifestApp(appDir);

    writeProjectFile(
      appDir,
      "src/api/users.ts",
      `export function GET() {
  return new Response("users");
}
`,
    );
    writeProjectFile(
      appDir,
      "src/api/users/index.ts",
      `export function GET() {
  return new Response("users-index");
}
`,
    );

    const result = runCliStatus(["verify", "--json"], { cwd: appDir });
    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => check.message.includes("duplicate paths"))).toBe(true);
  });

  it("limits verify --changed to changed framework files", () => {
    const appDir = createTempDir("pracht-cli-verify-changed-");
    writeManifestApp(appDir, {
      routesSource: `import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  routes: [route("/dashboard", "./routes/dashboard.tsx", { id: "dashboard", render: "ssr" })],
});
`,
    });

    writeProjectFile(
      appDir,
      "src/routes/dashboard.tsx",
      `export function Component() {
  return <h1>Dashboard</h1>;
}
`,
    );

    initializeGitRepo(appDir);

    writeProjectFile(
      appDir,
      "src/routes/dashboard.tsx",
      `export function Component() {
  return <h1>Updated dashboard</h1>;
}
`,
    );
    writeProjectFile(appDir, "notes.txt", "ignored");

    const result = runCli(["verify", "--changed", "--json"], { cwd: appDir });
    const report = JSON.parse(result.stdout);

    expect(report.ok).toBe(true);
    expect(report.scope).toBe("changed");
    expect(report.frameworkFiles).toContain("src/routes/dashboard.tsx");
    expect(report.frameworkFiles).not.toContain("notes.txt");
    expect(
      report.checks.some(
        (check) =>
          check.message.includes("Changed route module") &&
          check.message.includes("src/routes/dashboard.tsx"),
      ),
    ).toBe(true);
  });

  it("inspects resolved routes, api handlers, and build metadata as JSON", () => {
    const appDir = createRepoTempDir("pracht-cli-inspect-");
    writeInspectableManifestApp(appDir);

    const routes = JSON.parse(runCli(["inspect", "routes", "--json"], { cwd: appDir }).stdout);
    const api = JSON.parse(runCli(["inspect", "api", "--json"], { cwd: appDir }).stdout);
    const build = JSON.parse(runCli(["inspect", "build", "--json"], { cwd: appDir }).stdout);
    const all = JSON.parse(runCli(["inspect", "--json"], { cwd: appDir }).stdout);

    expect(routes).toEqual({
      mode: "manifest",
      routes: [
        {
          file: "./routes/dashboard.tsx",
          id: "dashboard",
          loaderCache: null,
          loaderFile: "./server/dashboard-loader.ts",
          middleware: ["auth"],
          path: "/dashboard",
          render: "isg",
          revalidate: {
            kind: "time",
            seconds: 60,
          },
          shell: "app",
          shellFile: "./shells/app.tsx",
        },
      ],
    });

    expect(api).toEqual({
      api: [
        {
          file: "/src/api/health.ts",
          methods: ["GET", "POST"],
          path: "/api/health",
        },
      ],
      mode: "manifest",
    });

    expect(build).toEqual({
      build: {
        adapterTarget: "node",
        clientEntryUrl: "/assets/client.js",
        cssManifest: {
          "src/routes/dashboard.tsx": ["/assets/dashboard.css"],
          "src/shells/app.tsx": ["/assets/app.css"],
        },
        jsManifest: {
          "src/routes/dashboard.tsx": ["/assets/dashboard.js", "/assets/vendor.js"],
          "src/shells/app.tsx": ["/assets/app.js", "/assets/vendor.js"],
        },
      },
      mode: "manifest",
    });

    expect(all).toEqual({
      ...routes,
      ...api,
      ...build,
    });
  }, 30_000);

  it("generates typed route declarations and href helpers for manifest apps", () => {
    const appDir = createRepoTempDir("pracht-cli-typegen-manifest-");
    writeTypedManifestApp(appDir);

    const result = JSON.parse(runCli(["typegen", "--json"], { cwd: appDir }).stdout);
    const declaration = readFileSync(join(appDir, "src/pracht-routes.d.ts"), "utf-8");
    const runtime = readFileSync(join(appDir, "src/pracht-routes.ts"), "utf-8");

    expect(result).toMatchObject({
      check: false,
      files: ["src/pracht-routes.d.ts", "src/pracht-routes.ts"],
      mode: "manifest",
      ok: true,
      routes: 3,
    });
    expect(declaration).toContain(
      'import type { RouteLoaderData, RouteParamInput, SearchParamsInput } from "@pracht/core";',
    );
    expect(declaration).toContain('"home": {');
    expect(declaration).toContain("params: Record<never, never>;");
    expect(declaration).toContain('"product": {');
    expect(declaration).toContain('params: { "id": RouteParamInput; };');
    // Route without a loader still points at its module; RouteLoaderData
    // resolves to undefined until a loader export appears.
    expect(declaration).toContain('data: RouteLoaderData<typeof import("./routes/home")>;');
    // Inline loader.
    expect(declaration).toContain('data: RouteLoaderData<typeof import("./routes/product")>;');
    // Manifest-wired separate loader file wins over the route module.
    expect(declaration).toContain(
      'data: RouteLoaderData<typeof import("./server/dashboard-loader"), typeof import("./routes/dashboard")>;',
    );
    expect(runtime).toContain('id: "product"');
    expect(runtime).toContain('path: "/products/:id"');
    expect(runtime).toContain("export const href = createHref(routes);");

    const check = JSON.parse(runCli(["typegen", "--check", "--json"], { cwd: appDir }).stdout);
    expect(check).toMatchObject({ check: true, ok: true, routes: 3 });

    writeProjectFile(appDir, "src/pracht-routes.d.ts", "stale\n");
    const stale = runCliStatus(["typegen", "--check", "--json"], { cwd: appDir });
    expect(stale.status).toBe(1);
    expect(JSON.parse(stale.stderr)).toMatchObject({ ok: false });
  }, 30_000);

  it("generates typed route declarations for pages-router apps", () => {
    const appDir = createRepoTempDir("pracht-cli-typegen-pages-");
    writeInspectablePagesApp(appDir);

    const result = JSON.parse(runCli(["typegen", "--json"], { cwd: appDir }).stdout);
    const declaration = readFileSync(join(appDir, "src/pracht-routes.d.ts"), "utf-8");

    expect(result).toMatchObject({ mode: "pages", ok: true, routes: 2 });
    expect(declaration).toContain('"index": {');
    expect(declaration).toContain('"blog-slug": {');
    expect(declaration).toContain('params: { "slug": RouteParamInput; };');
    expect(declaration).toContain('data: RouteLoaderData<typeof import("./pages/index")>;');
    expect(declaration).toContain('data: RouteLoaderData<typeof import("./pages/blog/[slug]")>;');
  }, 30_000);

  it("scaffolds pages-router routes without touching a manifest", () => {
    const appDir = createTempDir("pracht-cli-pages-");
    writePagesApp(appDir);

    runCli(["generate", "route", "--path", "/blog/:slug", "--render", "ssg", "--loader"], {
      cwd: appDir,
    });

    const routePath = join(appDir, "src/pages/blog/[slug].tsx");
    expect(existsSync(routePath)).toBe(true);

    const routeSource = readFileSync(routePath, "utf-8");
    expect(routeSource).toContain('export const RENDER_MODE = "ssg";');
    expect(routeSource).toContain("export function getStaticPaths()");
    expect(routeSource).toContain('slug: "example-slug"');
  });
});

function createTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createRepoTempDir(prefix) {
  mkdirSync(repoTempRoot, { recursive: true });
  const dir = mkdtempSync(join(repoTempRoot, prefix));
  tempDirs.push(dir);
  return dir;
}

function runCli(args, { cwd }) {
  return {
    stdout: execFileSync(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: "utf-8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  };
}

function runCliStatus(args, { cwd }) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf-8",
    env: process.env,
  });
}

function initializeGitRepo(appDir) {
  execFileSync("git", ["init"], {
    cwd: appDir,
    env: process.env,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: appDir,
    env: process.env,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Pracht Tests"], {
    cwd: appDir,
    env: process.env,
    stdio: "ignore",
  });
  execFileSync("git", ["add", "."], {
    cwd: appDir,
    env: process.env,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "-m", "initial"], {
    cwd: appDir,
    env: process.env,
    stdio: "ignore",
  });
}

function writeManifestApp(appDir, { routesSource } = {}) {
  writeProjectFile(
    appDir,
    "package.json",
    JSON.stringify(
      {
        name: "fixture-app",
        private: true,
        dependencies: {
          "@pracht/adapter-node": "workspace:*",
          "@pracht/cli": "workspace:*",
        },
      },
      null,
      2,
    ),
  );
  writeProjectFile(
    appDir,
    "vite.config.ts",
    `import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht()],
});
`,
  );
  writeProjectFile(
    appDir,
    "src/routes.ts",
    routesSource ??
      `import { defineApp } from "@pracht/core";

export const app = defineApp({
  routes: [],
});
`,
  );
}

function writeTypedManifestApp(appDir) {
  const vitePluginImport = pathToFileURL(vitePluginImportPath).href;

  writeProjectFile(
    appDir,
    "package.json",
    JSON.stringify(
      {
        name: "fixture-typegen-app",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
  writeProjectFile(
    appDir,
    "vite.config.ts",
    `import { defineConfig } from "vite";
import { pracht } from ${JSON.stringify(vitePluginImport)};

export default defineConfig({
  plugins: [pracht()],
  resolve: {
    alias: {
      "@pracht/adapter-node": ${JSON.stringify(nodeAdapterImportPath)},
      "@pracht/core": ${JSON.stringify(coreImportPath)},
    },
  },
});
`,
  );
  writeProjectFile(
    appDir,
    "src/routes.ts",
    `import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  routes: [
    route("/", "./routes/home.tsx", { id: "home", render: "ssg" }),
    route("/products/:id", "./routes/product.tsx", { id: "product", render: "ssr" }),
    route("/dashboard", {
      component: "./routes/dashboard.tsx",
      loader: "./server/dashboard-loader.ts",
      id: "dashboard",
      render: "ssr",
    }),
  ],
});
`,
  );
  writeProjectFile(appDir, "src/routes/home.tsx", "export function Component() { return null; }\n");
  writeProjectFile(
    appDir,
    "src/routes/product.tsx",
    `export async function loader() {
  return { product: { id: "sku-1" } };
}

export function Component() { return null; }
`,
  );
  writeProjectFile(
    appDir,
    "src/routes/dashboard.tsx",
    "export function Component() { return null; }\n",
  );
  writeProjectFile(
    appDir,
    "src/server/dashboard-loader.ts",
    `export async function loader() {
  return { widgets: 3 };
}
`,
  );
}

function writeInspectablePagesApp(appDir) {
  const vitePluginImport = pathToFileURL(vitePluginImportPath).href;

  writeProjectFile(
    appDir,
    "package.json",
    JSON.stringify(
      {
        name: "fixture-typegen-pages-app",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
  writeProjectFile(
    appDir,
    "vite.config.ts",
    `import { defineConfig } from "vite";
import { pracht } from ${JSON.stringify(vitePluginImport)};

export default defineConfig({
  plugins: [pracht({ pagesDir: "/src/pages" })],
  resolve: {
    alias: {
      "@pracht/adapter-node": ${JSON.stringify(nodeAdapterImportPath)},
      "@pracht/core": ${JSON.stringify(coreImportPath)},
    },
  },
});
`,
  );
  writeProjectFile(appDir, "src/pages/index.tsx", "export function Component() { return null; }\n");
  writeProjectFile(
    appDir,
    "src/pages/blog/[slug].tsx",
    `export async function loader() {
  return { slug: "hello" };
}

export function Component() { return null; }
`,
  );
}

function writeInspectableManifestApp(appDir) {
  const vitePluginImport = pathToFileURL(vitePluginImportPath).href;

  writeProjectFile(
    appDir,
    "package.json",
    JSON.stringify(
      {
        name: "fixture-inspect-app",
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
  writeProjectFile(
    appDir,
    "vite.config.ts",
    `import { defineConfig } from "vite";
import { pracht } from ${JSON.stringify(vitePluginImport)};

export default defineConfig({
  plugins: [pracht()],
  resolve: {
    alias: {
      "@pracht/adapter-node": ${JSON.stringify(nodeAdapterImportPath)},
      "@pracht/core": ${JSON.stringify(coreImportPath)},
    },
  },
});
`,
  );
  writeProjectFile(
    appDir,
    "src/routes.ts",
    `import { defineApp, group, route, timeRevalidate } from "@pracht/core";

export const app = defineApp({
  shells: {
    app: () => import("./shells/app.tsx"),
  },
  middleware: {
    auth: () => import("./middleware/auth.ts"),
  },
  routes: [
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", {
        component: () => import("./routes/dashboard.tsx"),
        loader: () => import("./server/dashboard-loader.ts"),
        render: "isg",
        revalidate: timeRevalidate(60),
      }),
    ]),
  ],
});
`,
  );
  writeProjectFile(
    appDir,
    "src/routes/dashboard.tsx",
    `import type { RouteComponentProps } from "@pracht/core";

export function Component({ data }: RouteComponentProps) {
  return <main>{JSON.stringify(data)}</main>;
}
`,
  );
  writeProjectFile(
    appDir,
    "src/server/dashboard-loader.ts",
    `import type { LoaderArgs } from "@pracht/core";

export async function loader(_args: LoaderArgs) {
  return { ok: true };
}
`,
  );
  writeProjectFile(
    appDir,
    "src/shells/app.tsx",
    `import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return <div>{children}</div>;
}
`,
  );
  writeProjectFile(
    appDir,
    "src/middleware/auth.ts",
    `import type { MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async (_args, next) => {
  return next();
};
`,
  );
  writeProjectFile(
    appDir,
    "src/api/health.ts",
    `import type { BaseRouteArgs } from "@pracht/core";

export function GET(_args: BaseRouteArgs) {
  return Response.json({ ok: true });
}

export async function POST(_args: BaseRouteArgs) {
  return Response.json({ created: true }, { status: 201 });
}
`,
  );
  writeProjectFile(
    appDir,
    "dist/client/.vite/manifest.json",
    JSON.stringify(
      {
        "virtual:pracht/client": {
          file: "assets/client.js",
          imports: ["assets/vendor.js"],
        },
        "src/routes/dashboard.tsx": {
          css: ["assets/dashboard.css"],
          file: "assets/dashboard.js",
          imports: ["assets/vendor.js"],
          src: "src/routes/dashboard.tsx",
        },
        "src/shells/app.tsx": {
          css: ["assets/app.css"],
          file: "assets/app.js",
          imports: ["assets/vendor.js"],
          src: "src/shells/app.tsx",
        },
        "assets/vendor.js": {
          file: "assets/vendor.js",
        },
      },
      null,
      2,
    ),
  );
}

function writePagesApp(appDir) {
  writeProjectFile(
    appDir,
    "package.json",
    JSON.stringify(
      {
        name: "fixture-pages-app",
        private: true,
        dependencies: {
          "@pracht/adapter-node": "workspace:*",
          "@pracht/cli": "workspace:*",
        },
      },
      null,
      2,
    ),
  );
  writeProjectFile(
    appDir,
    "vite.config.ts",
    `import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ pagesDir: "/src/pages" })],
});
`,
  );
}

function writeProjectFile(appDir, relativePath, contents) {
  const filePath = resolve(appDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents.endsWith("\n") ? contents : `${contents}\n`, "utf-8");
}
