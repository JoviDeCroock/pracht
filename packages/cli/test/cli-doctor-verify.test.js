import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  createTempDir,
  initializeGitRepo,
  runCli,
  runCliStatus,
  writeManifestApp,
  writePagesApp,
  writeProjectFile,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

describe("@pracht/cli doctor and verify", () => {
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

  it.each(["404.tsx", "404/index.tsx"])(
    "reports a pages-router %s as the not-found page instead of a route",
    (notFoundFile) => {
      const appDir = createTempDir("pracht-cli-doctor-pages-not-found-");
      writePagesApp(appDir);
      writeProjectFile(appDir, "src/pages/_app.tsx", "export function Shell() { return null; }");
      writeProjectFile(
        appDir,
        "src/pages/index.tsx",
        "export function Component() { return null; }",
      );
      writeProjectFile(
        appDir,
        `src/pages/${notFoundFile}`,
        "export function Component() { return null; }",
      );

      const result = runCli(["doctor", "--json"], { cwd: appDir });
      const report = JSON.parse(result.stdout);

      expect(report.ok).toBe(true);
      expect(report.checks.some((check) => check.message === "Found 1 page route.")).toBe(true);
      expect(
        report.checks.some((check) => check.message === "Found a pages-router not-found page."),
      ).toBe(true);
      expect(report.checks.some((check) => check.message === "Found 2 page routes.")).toBe(false);
    },
  );

  it("rejects multiple pages-router not-found files", () => {
    const appDir = createTempDir("pracht-cli-doctor-pages-not-found-duplicate-");
    writePagesApp(appDir);
    writeProjectFile(appDir, "src/pages/index.tsx", "export function Component() { return null; }");
    writeProjectFile(appDir, "src/pages/404.tsx", "export function Component() { return null; }");
    writeProjectFile(
      appDir,
      "src/pages/404/index.tsx",
      "export function Component() { return null; }",
    );

    const result = runCliStatus(["doctor", "--json"], { cwd: appDir });
    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => check.message.includes("multiple not-found pages"))).toBe(
      true,
    );
  });

  it("rejects a second pages-router not-found file in changed verification", () => {
    const appDir = createTempDir("pracht-cli-verify-pages-not-found-duplicate-");
    writePagesApp(appDir);
    writeProjectFile(appDir, "src/pages/index.tsx", "export function Component() { return null; }");
    writeProjectFile(appDir, "src/pages/404.tsx", "export function Component() { return null; }");
    initializeGitRepo(appDir);
    writeProjectFile(
      appDir,
      "src/pages/404/index.tsx",
      "export function Component() { return null; }",
    );

    const result = runCliStatus(["verify", "--changed", "--json"], { cwd: appDir });
    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.scope).toBe("changed");
    expect(report.frameworkFiles).toContain("src/pages/404/index.tsx");
    expect(report.checks.some((check) => check.message.includes("multiple not-found pages"))).toBe(
      true,
    );
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
});
