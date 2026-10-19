import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  createRepoTempDir,
  runCliStatus,
  writeManifestApp,
  writeProjectFile,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

function verify(appDir, command = "verify") {
  const result = runCliStatus([command, "--json"], { cwd: appDir });
  return { status: result.status, report: JSON.parse(result.stdout) };
}

function messages(report, status) {
  return report.checks
    .filter((check) => status === undefined || check.status === status)
    .map((check) => check.message);
}

// `doctor` and `verify` read the manifest the way dev and build do: through
// the resolved app graph, not a text scan of routes.ts.
describe("@pracht/cli verify reads the resolved app graph", () => {
  it("follows routes spread in from another module and its extensionless import", () => {
    const appDir = createRepoTempDir("pracht-cli-verify-graph-spread-");
    writeManifestApp(appDir, {
      routesSource: `import { defineApp, route } from "@pracht/core";
import { blogRoutes } from "./blog-routes";

export const app = defineApp({
  routes: [
    route("/", "./routes/home.tsx", { id: "home", render: "ssr" }),
    ...blogRoutes,
  ],
});
`,
    });
    writeProjectFile(
      appDir,
      "src/blog-routes.ts",
      `import { route } from "@pracht/core";

export const blogRoutes = [
  route("/blog/:slug", "./routes/blog/missing.tsx", { id: "blog-slug", render: "ssr" }),
];
`,
    );
    writeProjectFile(appDir, "src/routes/home.tsx", "export function Component() { return null; }");

    for (const command of ["verify", "doctor"]) {
      const { status, report } = verify(appDir, command);
      const errors = messages(report, "error");
      // The extensionless import is a normal TypeScript import, not a module path.
      expect(errors.join("\n")).not.toContain('"./blog-routes"');
      // The spread-in route's missing module is reported.
      expect(errors).toContainEqual(expect.stringContaining('"./routes/blog/missing.tsx"'));
      expect(messages(report)).toContain("App manifest defines 2 routes.");
      expect(status).toBe(1);
    }
  });

  it("passes an app that splits its manifest across modules", () => {
    const appDir = createRepoTempDir("pracht-cli-verify-graph-split-ok-");
    writeManifestApp(appDir, {
      routesSource: `import { defineApp, route } from "@pracht/core";
import { blogRoutes } from "./blog-routes";

export const app = defineApp({
  routes: [route("/", "./routes/home.tsx", { id: "home", render: "ssr" }), ...blogRoutes],
});
`,
    });
    writeProjectFile(
      appDir,
      "src/blog-routes.ts",
      `import { route } from "@pracht/core";

export const blogRoutes = [route("/blog", "./routes/blog.tsx", { id: "blog", render: "ssr" })];
`,
    );
    writeProjectFile(appDir, "src/routes/home.tsx", "export function Component() { return null; }");
    writeProjectFile(appDir, "src/routes/blog.tsx", "export function Component() { return null; }");

    const { status, report } = verify(appDir);
    expect(messages(report, "error")).toEqual([]);
    expect(messages(report)).toContain("App manifest defines 2 routes.");
    expect(status).toBe(0);
  });

  it("enforces constraints passed with the shorthand property", () => {
    const appDir = createRepoTempDir("pracht-cli-verify-graph-constraints-");
    writeManifestApp(appDir, {
      routesSource: `import { defineApp, forbidRenderMode, route } from "@pracht/core";

const constraints = [forbidRenderMode("**", "ssg")];

export const app = defineApp({
  routes: [route("/", "./routes/home.tsx", { id: "home", render: "ssg" })],
  constraints,
});
`,
    });
    writeProjectFile(appDir, "src/routes/home.tsx", "export function Component() { return null; }");

    const { status, report } = verify(appDir);
    expect(status).toBe(1);
    expect(messages(report, "error").join("\n")).toMatch(/ssg/i);
  });

  it("resolves a bare route module path against the manifest", () => {
    const appDir = createRepoTempDir("pracht-cli-verify-graph-bare-");
    writeManifestApp(appDir, {
      routesSource: `import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  routes: [route("/", "routes/home.tsx", { id: "home", render: "ssr" })],
});
`,
    });
    writeProjectFile(appDir, "src/routes/home.tsx", "export function Component() { return null; }");

    const { status, report } = verify(appDir);
    expect(messages(report, "error")).toEqual([]);
    expect(status).toBe(0);
  });

  it("warns when the app graph cannot be resolved instead of passing silently", () => {
    const appDir = createRepoTempDir("pracht-cli-verify-graph-unresolved-");
    writeManifestApp(appDir, {
      routesSource: `import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  routes: [route("/", "./routes/home.tsx", { id: "home", render: "ssr", shell: "typo" })],
});
`,
    });
    writeProjectFile(appDir, "src/routes/home.tsx", "export function Component() { return null; }");

    const { report } = verify(appDir);
    expect(messages(report, "warning").join("\n")).toContain("Could not resolve the app graph");
  });

  // R486-1: a graph failure in an imported fragment still counts the routes
  // the manifest reaches, from the plugin's static facts, and names the error.
  it("counts the routes of an unresolvable graph from the manifest facts", () => {
    const appDir = createRepoTempDir("pracht-cli-verify-graph-fragment-");
    writeManifestApp(appDir, {
      routesSource: `import { defineApp } from "@pracht/core";
import { more } from "./more.ts";

export const app = defineApp({ routes: [...more] });
`,
    });
    writeProjectFile(
      appDir,
      "src/more.ts",
      `import { route } from "@pracht/core";
export const more = [
  route("/", "routes/home.tsx", { id: "home", render: "ssr", shell: "typo" }),
  route("/gone", "./routes/gone.tsx", { id: "gone", render: "ssr" }),
];
`,
    );
    writeProjectFile(appDir, "src/routes/home.tsx", "export function Component() { return null; }");

    const { status, report } = verify(appDir);
    expect(messages(report)).toContain("App manifest defines 2 routes.");
    expect(messages(report)).not.toContain("No routes were found in the app manifest.");
    expect(messages(report, "warning").join("\n")).toMatch(/Could not resolve the app graph.*typo/);
    // R486-2: the bare ref resolves against the manifest; only the real gap is named.
    expect(messages(report, "error")).toEqual([
      'Manifest references missing files: "./routes/gone.tsx".',
    ]);
    expect(status).toBe(1);
  });
});
