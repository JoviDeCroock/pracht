// Shared fixtures for the `pracht` CLI tests.
//
// The CLI suite spawns the real binary, so every test costs hundreds of
// milliseconds to seconds. Vitest parallelises across *files* (each runs in its
// own worker) but never within one, so these tests are split into several
// focused files that all pull their app fixtures from here.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const cliPath = fileURLToPath(new URL("../../bin/pracht.js", import.meta.url));
export const repoRoot = resolve(dirname(cliPath), "../../..");
const repoTempRoot = resolve(dirname(cliPath), "../test/.tmp");
export const coreImportPath = resolve(repoRoot, "packages/framework/src/index.ts");
export const capabilitiesImportPath = resolve(repoRoot, "packages/capabilities/src/index.ts");
export const nodeAdapterImportPath = resolve(repoRoot, "packages/adapter-node/src/index.ts");
export const vitePluginImportPath = resolve(repoRoot, "packages/vite-plugin/src/index.ts");
export const standardSchemaImportPath = resolve(
  repoRoot,
  "packages/framework/node_modules/@standard-schema/spec/dist/index.d.ts",
);
// The api-types compile test consumes the built declarations like a real
// project would (skipLibCheck leaves them unchecked); compiling the framework
// *source* alongside a populated Register augmentation is not supported.
export const coreDistTypesPath = resolve(repoRoot, "packages/framework/dist/index.d.mts");
export const capabilitiesDistTypesPath = resolve(
  repoRoot,
  "packages/capabilities/dist/index.d.mts",
);
// Ambient declarations for `virtual:pracht/capabilities`, the module the Vite
// plugin generates. The capability-types compile test includes it so the typed
// browser client is checked exactly as an app would see it.
export const virtualTypesPath = resolve(repoRoot, "packages/vite-plugin/virtual.d.ts");
export const tscPath = resolve(repoRoot, "node_modules/typescript/bin/tsc");

const tempDirs = [];

/** Removes every temp dir created since the last cleanup. Call from afterEach. */
export function cleanupTempDirs() {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
}

export async function waitFor(predicate, timeoutMs, describeFailure) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Timed out waiting for condition.${describeFailure ? `\n${describeFailure()}` : ""}`,
  );
}

export function createTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function createRepoTempDir(prefix) {
  mkdirSync(repoTempRoot, { recursive: true });
  const dir = mkdtempSync(join(repoTempRoot, prefix));
  tempDirs.push(dir);
  return dir;
}

export function runCli(args, { cwd }) {
  return {
    stdout: execFileSync(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: "utf-8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  };
}

export function runCliStatus(args, { cwd }) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf-8",
    env: process.env,
  });
}

/** Runs `tsc -p .` in the fixture, rethrowing the diagnostics as the failure. */
export function typecheckFixture(appDir, extraArgs = []) {
  try {
    execFileSync(process.execPath, [tscPath, "-p", ".", ...extraArgs], {
      cwd: appDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(error.stdout || error.stderr || error.message);
  }
}

export function initializeGitRepo(appDir) {
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

export function writeManifestApp(appDir, { routesSource } = {}) {
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

export function writeTypedManifestApp(appDir, { capabilities = false } = {}) {
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
      "@pracht/capabilities": ${JSON.stringify(capabilitiesImportPath)},
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
${
  capabilities
    ? `  capabilities: {
    "notes.search": () => import("./capabilities/notes-search.ts"),
    "notes.set-status": () => import("./capabilities/notes-set-status.ts"),
    "notes.purge": () => import("./capabilities/notes-purge.ts"),
    "notes.stats": () => import("./capabilities/notes-stats.ts"),
  },
`
    : ""
}  routes: [
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
  if (capabilities) {
    writeProjectFile(
      appDir,
      "src/capabilities/notes-search.ts",
      `import { defineCapability } from "@pracht/capabilities";

export default defineCapability({
  title: "Search notes",
  description: "Find notes matching a query.",
  input: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: { notes: { type: "array", items: { type: "object" } } },
    required: ["notes"],
  },
  effect: "read",
  expose: { http: true },
  async run() {
    return { notes: [] };
  },
});
`,
    );
    writeProjectFile(
      appDir,
      "src/capabilities/notes-set-status.ts",
      `import { defineCapability } from "@pracht/capabilities";

export default defineCapability({
  title: "Set note status",
  description: "Move a note between draft and published.",
  input: {
    type: "object",
    properties: {
      id: { type: "string" },
      status: { enum: ["draft", "published"] },
    },
    required: ["id", "status"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: { updated: { const: true } },
    required: ["updated"],
    additionalProperties: false,
  },
  effect: "write",
  async run() {
    return { updated: true };
  },
});
`,
    );
    writeProjectFile(
      appDir,
      "src/capabilities/notes-purge.ts",
      `import { defineCapability } from "@pracht/capabilities";

export default defineCapability({
  title: "Purge notes",
  description: "Permanently delete notes matching a prefix.",
  input: {
    type: "object",
    properties: { titlePrefix: { type: "string" } },
    required: ["titlePrefix"],
    additionalProperties: false,
  },
  output: {
    type: "object",
    properties: { purged: { type: "integer" } },
    required: ["purged"],
    additionalProperties: false,
  },
  effect: "destructive",
  expose: { http: true },
  async run() {
    return { purged: 0 };
  },
});
`,
    );
    writeProjectFile(
      appDir,
      "src/capabilities/notes-stats.ts",
      `import { defineCapability } from "@pracht/capabilities";

export default defineCapability({
  title: "Note stats",
  description: "Counts across every note.",
  input: { type: "object", properties: {}, additionalProperties: false },
  output: {
    type: "object",
    properties: { total: { type: "integer" } },
    required: ["total"],
    additionalProperties: false,
  },
  effect: "read",
  expose: { http: true },
  async run() {
    return { total: 0 };
  },
});
`,
    );
  }
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
  writeProjectFile(
    appDir,
    "src/lib/schema-util.ts",
    `import type { StandardSchemaV1 } from "@standard-schema/spec";

export function passthroughSchema<TInput, TOutput = TInput>(): StandardSchemaV1<TInput, TOutput> {
  return {
    "~standard": {
      version: 1,
      vendor: "fixture",
      validate: (value) => ({ value: value as TOutput }),
    },
  };
}
`,
  );
  writeProjectFile(
    appDir,
    "src/api/items/[id].ts",
    `import { defineApi } from "@pracht/core";
import { passthroughSchema } from "../../lib/schema-util";

export const GET = defineApi({
  params: passthroughSchema<{ id: string }, { id: number }>(),
  handler: ({ params }) => ({ id: params.id }),
});

export const HEAD = defineApi({
  handler: ({ params }) => ({ id: params.id }),
});

export default async function handler() {
  return new Response("fallback");
}

export const DELETE = defineApi({
  params: passthroughSchema<{ id: number }>(),
  handler: () => ({ deleted: true }),
});
`,
  );
  writeProjectFile(
    appDir,
    "src/api/items/index.ts",
    `import { writeFileSync } from "node:fs";
import { defineApi } from "@pracht/core";
import { passthroughSchema } from "../../lib/schema-util";

writeFileSync("api-module-loaded", "typegen executed an API module");

export const POST = defineApi({
  body: passthroughSchema<{ name: string }>(),
  handler: ({ body }) => ({ created: body.name }),
});

export const PUT = defineApi({
  body: passthroughSchema<{ id: number }>(),
  handler: () =>
    Math.random() > 0.5 ? { updated: true } : new Response(null, { status: 204 }),
});
`,
  );
  writeProjectFile(
    appDir,
    "src/api/uploads.ts",
    `import { defineApi, json } from "@pracht/core";
import { passthroughSchema } from "../lib/schema-util";

export const POST = defineApi({
  body: passthroughSchema<{ name: string; avatar: File }>(),
  handler: ({ body }) => json({ uploaded: body.name }, { status: 201 }),
});

export const GET = defineApi({
  query: passthroughSchema<{ q: string; page?: number }>(),
  handler: ({ query }) => ({ results: [query.q] }),
});
`,
  );
}

export function writeInspectablePagesApp(appDir) {
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

export function writeInspectableManifestApp(appDir) {
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
        hydration: "full",
        prefetch: "hover",
        render: "isg",
        revalidate: timeRevalidate(60),
        speculation: "prefetch",
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
    "src/api/webhook.ts",
    `import type { BaseRouteArgs } from "@pracht/core";

export default async function handler(_args: BaseRouteArgs) {
  return Response.json({ received: true });
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

export function writePagesApp(appDir) {
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

export function writeProjectFile(appDir, relativePath, contents) {
  const filePath = resolve(appDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents.endsWith("\n") ? contents : `${contents}\n`, "utf-8");
}
