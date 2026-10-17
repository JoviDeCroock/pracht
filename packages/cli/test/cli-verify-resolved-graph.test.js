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
});
