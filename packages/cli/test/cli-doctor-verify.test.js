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

function writeCloudflareManifestApp(appDir) {
  writeManifestApp(appDir);
  writeProjectFile(
    appDir,
    "package.json",
    JSON.stringify(
      {
        name: "fixture-app",
        private: true,
        dependencies: {
          "@pracht/adapter-cloudflare": "workspace:*",
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
import { cloudflareAdapter } from "@pracht/adapter-cloudflare";

export default defineConfig({
  plugins: [pracht({ adapter: cloudflareAdapter() })],
});
`,
  );
}

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
  it("flags a Cloudflare wrangler config pointing at the non-worker server entry", () => {
    const appDir = createTempDir("pracht-cli-doctor-cf-entry-");
    writeCloudflareManifestApp(appDir);
    writeProjectFile(
      appDir,
      "wrangler.jsonc",
      `{
  "name": "fixture-app",
  "main": "dist/server/server.js",
  "compatibility_date": "2026-04-06"
}
`,
    );

    const result = runCli(["doctor", "--json"], { cwd: appDir });
    const report = JSON.parse(result.stdout);

    // A warning, not an error: adapter detection and wrangler parsing are both
    // heuristics, so this must never fail a build.
    expect(report.ok).toBe(true);
    expect(
      report.checks.some(
        (check) =>
          check.status === "warning" &&
          check.message.includes("wrangler.jsonc") &&
          check.message.includes("dist/server/worker.js"),
      ),
    ).toBe(true);
  });

  it("flags a Cloudflare env override pointing at the non-worker server entry", () => {
    const appDir = createTempDir("pracht-cli-doctor-cf-env-");
    writeCloudflareManifestApp(appDir);
    writeProjectFile(
      appDir,
      "wrangler.jsonc",
      `{
  "name": "fixture-app",
  // "main": "dist/server/server.js",
  "main": "dist/server/worker.js",
  "env": { "production": { "main": "dist/server/server.js" } }
}
`,
    );

    const result = runCli(["doctor", "--json"], { cwd: appDir });
    const report = JSON.parse(result.stdout);

    expect(
      report.checks.some(
        (check) => check.status === "warning" && check.message.includes('environment "production"'),
      ),
    ).toBe(true);
  });

  it("does not flag a commented-out Cloudflare main", () => {
    const appDir = createTempDir("pracht-cli-doctor-cf-comment-");
    writeCloudflareManifestApp(appDir);
    writeProjectFile(
      appDir,
      "wrangler.jsonc",
      `{
  "name": "fixture-app",
  // "main": "dist/server/server.js",
  "main": "dist/server/worker.js",
}
`,
    );

    const result = runCli(["doctor", "--json"], { cwd: appDir });
    const report = JSON.parse(result.stdout);

    expect(report.ok).toBe(true);
    // Silence on success: the reader skips wrangler shapes it does not
    // recognize, so a clean pass is "nothing provably wrong", not "verified".
    expect(report.checks.some((check) => check.message.includes("wrangler"))).toBe(false);
  });

  it("ignores a wrangler config when the app does not build for Cloudflare", () => {
    const appDir = createTempDir("pracht-cli-doctor-cf-other-adapter-");
    writeManifestApp(appDir);
    writeProjectFile(
      appDir,
      "package.json",
      JSON.stringify(
        {
          name: "fixture-app",
          private: true,
          dependencies: { "@pracht/cli": "workspace:*" },
          devDependencies: { "@pracht/adapter-cloudflare": "workspace:*" },
        },
        null,
        2,
      ),
    );
    writeProjectFile(
      appDir,
      "wrangler.toml",
      'name = "side-worker"\nmain = "dist/server/server.js"\n',
    );

    const result = runCli(["doctor", "--json"], { cwd: appDir });
    const report = JSON.parse(result.stdout);

    expect(report.ok).toBe(true);
    expect(report.checks.some((check) => check.message.includes("wrangler"))).toBe(false);
  });

  it("accepts a Cloudflare wrangler config pointing at the built worker entry", () => {
    const appDir = createTempDir("pracht-cli-doctor-cf-entry-ok-");
    writeCloudflareManifestApp(appDir);
    writeProjectFile(
      appDir,
      "wrangler.toml",
      'name = "fixture-app"\nmain = "dist/server/worker.js"\n',
    );

    const result = runCli(["doctor", "--json"], { cwd: appDir });
    const report = JSON.parse(result.stdout);

    expect(report.ok).toBe(true);
    // Silence on success: the reader skips wrangler shapes it does not
    // recognize, so a clean pass is "nothing provably wrong", not "verified".
    expect(report.checks.some((check) => check.message.includes("wrangler"))).toBe(false);
  });
  it("warns when a Markdown page is routed with no transform plugin", () => {
    const appDir = createTempDir("pracht-cli-doctor-md-page-");
    writePagesApp(appDir);
    writeProjectFile(appDir, "src/pages/guide.md", "# Guide\n\nHello.\n");

    const result = runCli(["doctor", "--json"], { cwd: appDir });
    const report = JSON.parse(result.stdout);

    // A warning, not an error: the app is only broken if it is actually built
    // or requested, and a plugin this list does not know about may well handle it.
    expect(report.ok).toBe(true);
    expect(
      report.checks.some(
        (check) =>
          check.status === "warning" &&
          check.message.includes("Markdown route") &&
          check.message.includes("src/pages/guide.md"),
      ),
    ).toBe(true);
  });

  it("stays quiet about Markdown routes when a transform plugin is registered", () => {
    const withPlugin = createTempDir("pracht-cli-doctor-md-plugin-");
    const withoutPlugin = createTempDir("pracht-cli-doctor-md-no-plugin-");

    for (const appDir of [withPlugin, withoutPlugin]) {
      writePagesApp(appDir);
      writeProjectFile(appDir, "src/pages/guide.md", "# Guide\n\nHello.\n");
    }
    writeProjectFile(
      withPlugin,
      "vite.config.ts",
      `import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";
import mdx from "@mdx-js/rollup";

export default defineConfig({
  plugins: [mdx(), pracht({ pagesDir: "/src/pages" })],
});
`,
    );

    const hasWarning = (appDir) =>
      JSON.parse(runCli(["doctor", "--json"], { cwd: appDir }).stdout).checks.some((check) =>
        check.message.includes("Markdown route"),
      );

    // Paired: the negative case only means something next to a positive one in
    // the same shape, otherwise it passes with the feature deleted.
    expect(hasWarning(withoutPlugin)).toBe(true);
    expect(hasWarning(withPlugin)).toBe(false);
  });

  it("warns about a Markdown not-found page and under --changed scope", () => {
    const appDir = createTempDir("pracht-cli-doctor-md-404-");
    writePagesApp(appDir);
    writeProjectFile(appDir, "src/pages/404.md", "# Gone\n");

    const full = JSON.parse(runCli(["doctor", "--json"], { cwd: appDir }).stdout);
    expect(
      full.checks.some(
        (check) => check.status === "warning" && check.message.includes("src/pages/404.md"),
      ),
    ).toBe(true);

    initializeGitRepo(appDir);
    writeProjectFile(appDir, "src/pages/404.md", "# Gone for good\n");
    const changed = JSON.parse(runCli(["verify", "--changed", "--json"], { cwd: appDir }).stdout);
    expect(changed.checks.some((check) => check.message.includes("Markdown route"))).toBe(true);
  });

  it("warns about a Markdown route module in a manifest app", () => {
    const appDir = createTempDir("pracht-cli-doctor-md-manifest-");
    writeManifestApp(appDir, {
      routesSource: `import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  routes: [route("/guide", "./routes/guide.md", { id: "guide", render: "ssg" })],
});
`,
    });
    writeProjectFile(appDir, "src/routes/guide.md", "# Guide\n");

    const report = JSON.parse(runCli(["doctor", "--json"], { cwd: appDir }).stdout);

    expect(
      report.checks.some(
        (check) => check.status === "warning" && check.message.includes("src/routes/guide.md"),
      ),
    ).toBe(true);
  });
});
