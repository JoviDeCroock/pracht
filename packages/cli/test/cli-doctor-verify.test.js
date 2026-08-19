import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  createRepoTempDir,
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

  it.each(["doctor", "verify"])("fails %s for pages ISG without REVALIDATE", (command) => {
    const appDir = createTempDir(`pracht-cli-${command}-pages-isg-missing-`);
    writePagesApp(appDir);
    writeProjectFile(
      appDir,
      "src/pages/index.tsx",
      'export const RENDER_MODE = "isg";\nexport function Component() { return null; }',
    );

    const result = runCliStatus([command, "--json"], { cwd: appDir });
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => check.message.includes("does not export"))).toBe(true);
  });

  it.each(["doctor", "verify"])(
    "accepts pages ISG with a positive time policy in %s",
    (command) => {
      const appDir = createTempDir(`pracht-cli-${command}-pages-isg-valid-`);
      writePagesApp(appDir);
      writeProjectFile(
        appDir,
        "src/pages/index.tsx",
        'export const RENDER_MODE = "isg";\nexport const REVALIDATE = 60;\nexport function Component() { return null; }',
      );

      const result = runCli([command, "--json"], { cwd: appDir });
      expect(JSON.parse(result.stdout).ok).toBe(true);
    },
  );

  it.each(["doctor", "verify"])("accepts a root pages _middleware in %s", (command) => {
    const appDir = createTempDir(`pracht-cli-${command}-pages-middleware-ok-`);
    writePagesApp(appDir);
    writeProjectFile(appDir, "src/pages/index.tsx", "export function Component() { return null; }");
    writeProjectFile(
      appDir,
      "src/pages/_middleware.ts",
      `import type { MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async (_args, next) => next();
`,
    );

    const result = runCli([command, "--json"], { cwd: appDir });
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.checks.some((check) => check.message.includes("Found pages middleware"))).toBe(
      true,
    );
  });

  it.each(["doctor", "verify"])("accepts a quoted pages middleware export in %s", (command) => {
    const appDir = createTempDir(`pracht-cli-${command}-pages-middleware-quoted-`);
    writePagesApp(appDir);
    writeProjectFile(appDir, "src/pages/index.tsx", "export function Component() { return null; }");
    writeProjectFile(
      appDir,
      "src/pages/_middleware.js",
      'const fn = async (_args, next) => next();\nexport { fn as "middleware" };',
    );

    const result = runCli([command, "--json"], { cwd: appDir });
    expect(JSON.parse(result.stdout).ok).toBe(true);
  });

  it.each(["doctor", "verify"])(
    "ignores underscore-prefixed pages directories in %s",
    (command) => {
      const appDir = createTempDir(`pracht-cli-${command}-pages-private-dir-`);
      writePagesApp(appDir);
      writeProjectFile(
        appDir,
        "src/pages/index.tsx",
        "export function Component() { return null; }",
      );
      writeProjectFile(
        appDir,
        "src/pages/_components/button.tsx",
        'export const RENDER_MODE = "isg"; export function Component() { return null; }',
      );
      writeProjectFile(appDir, "src/pages/_components/_app.tsx", "export const REVALIDATE = 60;");

      const result = runCli([command, "--json"], { cwd: appDir });
      const report = JSON.parse(result.stdout);
      expect(report.ok).toBe(true);
      expect(report.checks.some((check) => check.message === "Found 1 page route.")).toBe(true);
      expect(
        report.checks.some(
          (check) => check.message === "No `_app` shell was found in the pages directory.",
        ),
      ).toBe(true);
    },
  );

  it.each(["doctor", "verify"])(
    "fails %s when pages _middleware does not export middleware",
    (command) => {
      const appDir = createTempDir(`pracht-cli-${command}-pages-middleware-export-`);
      writePagesApp(appDir);
      writeProjectFile(
        appDir,
        "src/pages/index.tsx",
        "export function Component() { return null; }",
      );
      writeProjectFile(
        appDir,
        "src/pages/_middleware.ts",
        "export default async (_args, next) => next();",
      );

      const result = runCliStatus([command, "--json"], { cwd: appDir });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.ok).toBe(false);
      expect(
        report.checks.some((check) => check.message.includes("does not export `middleware`")),
      ).toBe(true);
    },
  );

  it("does not report invalid changed pages middleware as successful", () => {
    const appDir = createTempDir("pracht-cli-verify-pages-middleware-changed-invalid-");
    writePagesApp(appDir);
    writeProjectFile(appDir, "src/pages/index.tsx", "export function Component() { return null; }");
    writeProjectFile(
      appDir,
      "src/pages/_middleware.ts",
      "export const middleware = async (_args, next) => next();",
    );
    initializeGitRepo(appDir);
    writeProjectFile(
      appDir,
      "src/pages/_middleware.ts",
      "export default async (_args, next) => next();",
    );

    const result = runCliStatus(["verify", "--changed", "--json"], { cwd: appDir });
    expect(result.status).toBe(1);

    const report = JSON.parse(result.stdout);
    expect(report.scope).toBe("changed");
    expect(
      report.checks.some(
        (check) =>
          check.status === "error" && check.message.includes("does not export `middleware`"),
      ),
    ).toBe(true);
    expect(
      report.checks.some(
        (check) => check.status === "ok" && check.message.includes("Changed pages middleware"),
      ),
    ).toBe(false);
  });

  it.each(["admin", "_components"])(
    "fails doctor for nested pages _middleware files under %s",
    (directory) => {
      const appDir = createTempDir("pracht-cli-doctor-pages-middleware-nested-");
      writePagesApp(appDir);
      writeProjectFile(
        appDir,
        "src/pages/index.tsx",
        "export function Component() { return null; }",
      );
      writeProjectFile(
        appDir,
        `src/pages/${directory}/_middleware.ts`,
        "export const middleware = async (_args, next) => next();",
      );

      const result = runCliStatus(["doctor", "--json"], { cwd: appDir });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.ok).toBe(false);
      expect(report.checks.some((check) => check.message.includes("Nested pages middleware"))).toBe(
        true,
      );
    },
  );

  it("fails doctor for a _middleware directory instead of treating it as a route", () => {
    const appDir = createTempDir("pracht-cli-doctor-pages-middleware-dir-");
    writePagesApp(appDir);
    writeProjectFile(appDir, "src/pages/index.tsx", "export function Component() { return null; }");
    writeProjectFile(appDir, "src/pages/_middleware/.gitkeep", "");

    const result = runCliStatus(["doctor", "--json"], { cwd: appDir });
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(
      report.checks.some((check) =>
        check.message.includes("`_middleware` directory is not supported"),
      ),
    ).toBe(true);
    // The file inside the directory must never surface as a page route.
    expect(report.checks.some((check) => check.message.includes('route "/_middleware"'))).toBe(
      false,
    );
  });

  it.each([".md", ".mdx", ".tsrx"])(
    "fails doctor for _middleware%s instead of silently ignoring it",
    (extension) => {
      const appDir = createTempDir(`pracht-cli-doctor-pages-middleware-${extension.slice(1)}-`);
      writePagesApp(appDir);
      writeProjectFile(
        appDir,
        "src/pages/index.tsx",
        "export function Component() { return null; }",
      );
      writeProjectFile(
        appDir,
        `src/pages/_middleware${extension}`,
        "export const middleware = async (_args, next) => next();",
      );

      const result = runCliStatus(["doctor", "--json"], { cwd: appDir });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.ok).toBe(false);
      expect(
        report.checks.some((check) =>
          check.message.includes(`cannot use the \`${extension}\` extension`),
        ),
      ).toBe(true);
    },
  );

  it.each(["doctor", "verify"])(
    "fails %s for _middleware using a configured custom page extension",
    (command) => {
      const appDir = createTempDir(`pracht-cli-${command}-pages-middleware-custom-`);
      writePagesApp(appDir);
      writeProjectFile(
        appDir,
        "vite.config.ts",
        'import { pracht } from "@pracht/vite-plugin";\npracht({ pagesDir: "/src/pages", additionalExtensions: [".vue"] });',
      );
      writeProjectFile(
        appDir,
        "src/pages/index.tsx",
        "export function Component() { return null; }",
      );
      writeProjectFile(
        appDir,
        "src/pages/_middleware.vue",
        "<script>export const middleware = async (_args, next) => next();</script>",
      );

      const result = runCliStatus([command, "--json"], { cwd: appDir });
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.ok).toBe(false);
      expect(
        report.checks.some((check) => check.message.includes("cannot use the `.vue` extension")),
      ).toBe(true);
    },
  );

  it("reads an inline pagesDefaultRender as a render mode rather than a path", () => {
    const appDir = createTempDir("pracht-cli-doctor-pages-default-isg-");
    writePagesApp(appDir);
    writeProjectFile(
      appDir,
      "vite.config.ts",
      'import { pracht } from "@pracht/vite-plugin";\npracht({ pagesDir: "/src/pages", pagesDefaultRender: "isg" });',
    );
    writeProjectFile(
      appDir,
      "src/pages/index.tsx",
      "export const REVALIDATE = 90;\nexport function Component() { return null; }",
    );

    const report = JSON.parse(runCli(["doctor", "--json"], { cwd: appDir }).stdout);
    expect(report.ok).toBe(true);
  });

  it("resolves a pagesDefaultRender identifier bound to a quoted const", () => {
    const appDir = createTempDir("pracht-cli-doctor-pages-default-const-");
    writePagesApp(appDir);
    writeProjectFile(
      appDir,
      "vite.config.ts",
      'import { pracht } from "@pracht/vite-plugin";\nconst mode = "isg";\npracht({ pagesDir: "/src/pages", pagesDefaultRender: mode });',
    );
    writeProjectFile(
      appDir,
      "src/pages/index.tsx",
      "export const REVALIDATE = 90;\nexport function Component() { return null; }",
    );

    const report = JSON.parse(runCli(["doctor", "--json"], { cwd: appDir }).stdout);
    expect(report.ok).toBe(true);
  });

  it("warns for an unresolved non-ISG default without letting comments spoof it", () => {
    const appDir = createTempDir("pracht-cli-doctor-pages-default-unresolved-");
    writePagesApp(appDir);
    writeProjectFile(
      appDir,
      "vite.config.ts",
      [
        'import { pracht } from "@pracht/vite-plugin";',
        "const mode = getMode();",
        'function getMode() { return "ssr"; }',
        'const unrelated = { pagesDefaultRender: "isg" };',
        '// pagesDefaultRender: "isg"',
        'pracht({ pagesDir: "/src/pages", pagesDefaultRender: mode });',
      ].join("\n"),
    );
    writeProjectFile(appDir, "src/pages/index.tsx", "export function Component() { return null; }");

    const report = JSON.parse(runCli(["doctor", "--json"], { cwd: appDir }).stdout);
    expect(report.ok).toBe(true);
    expect(report.checks.some((check) => check.message.includes("could not be resolved"))).toBe(
      true,
    );
  });

  it("does not let commented or string-contained RENDER_MODE authorize REVALIDATE", () => {
    const appDir = createTempDir("pracht-cli-doctor-pages-commented-render-");
    writePagesApp(appDir);
    writeProjectFile(
      appDir,
      "src/pages/index.tsx",
      [
        '// export const RENDER_MODE = "isg";',
        "const example = 'export const RENDER_MODE = \"isg\"';",
        "export const REVALIDATE = 60;",
        "export function Component() { return example; }",
      ].join("\n"),
    );

    const result = runCliStatus(["doctor", "--json"], { cwd: appDir });
    expect(result.status).toBe(1);
    expect(
      JSON.parse(result.stdout).checks.some((check) => check.message.includes("only valid")),
    ).toBe(true);
  });

  it("ignores Markdown fenced policy examples", () => {
    const appDir = createTempDir("pracht-cli-doctor-pages-markdown-fence-");
    writePagesApp(appDir);
    writeProjectFile(
      appDir,
      "vite.config.ts",
      'import { pracht } from "@pracht/vite-plugin";\npracht({ pagesDir: "/src/pages", pagesDefaultRender: "isg" });',
    );
    writeProjectFile(
      appDir,
      "src/pages/guide.mdx",
      [
        "# Guide",
        "",
        "> ```ts",
        '> export const RENDER_MODE = "isg";',
        "> export const REVALIDATE = 60;",
        "> ```",
        "",
        "- ~~~ts",
        '  export const RENDER_MODE = "isg";',
        "  export const REVALIDATE = 30;",
        "  ~~~",
        "",
        "10. ~~~ts",
        "    export const REVALIDATE = 15;",
        "    ~~~",
        "",
        "export const REVALIDATE = 75;",
      ].join("\n"),
    );

    const report = JSON.parse(runCli(["doctor", "--json"], { cwd: appDir }).stdout);
    expect(report.ok).toBe(true);
  });

  it("rejects REVALIDATE on the pages app shell", () => {
    const appDir = createTempDir("pracht-cli-doctor-pages-shell-policy-");
    writePagesApp(appDir);
    writeProjectFile(appDir, "src/pages/index.tsx", "export function Component() { return null; }");
    writeProjectFile(appDir, "src/pages/_app.tsx", "export const REVALIDATE = 60;");

    const result = runCliStatus(["doctor", "--json"], { cwd: appDir });
    expect(result.status).toBe(1);
    expect(
      JSON.parse(result.stdout).checks.some((check) => check.message.includes("app shell")),
    ).toBe(true);
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
    // Live graph verification loads the Vite config, so keep this fixture
    // below the repository root where its workspace dependencies resolve.
    const appDir = createRepoTempDir("pracht-cli-verify-ok-");
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
    expect(
      report.checks.some(
        (check) => check.message === "Loaded 1 discovered API route module into the app graph.",
      ),
    ).toBe(true);
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
    const withContentWithoutCompiler = createTempDir("pracht-cli-doctor-content-plugin-");
    const withContentRegistryOnly = createTempDir("pracht-cli-doctor-content-registry-");
    const withoutPlugin = createTempDir("pracht-cli-doctor-md-no-plugin-");

    for (const appDir of [
      withPlugin,
      withContentWithoutCompiler,
      withContentRegistryOnly,
      withoutPlugin,
    ]) {
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
    writeProjectFile(
      withContentWithoutCompiler,
      "vite.config.ts",
      `import { defineConfig } from "vite";
import { prachtContent } from "@pracht/content/vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [prachtContent({ collections: [] }), pracht({ pagesDir: "/src/pages" })],
});
`,
    );
    writeProjectFile(
      withContentRegistryOnly,
      "vite.config.ts",
      `import { defineCollection } from "@pracht/content";
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

void defineCollection;
export default defineConfig({
  plugins: [pracht({ pagesDir: "/src/pages" })],
});
`,
    );

    // One CLI spawn per fixture: this test drives four apps, and re-running
    // doctor for each assertion pushes it past the suite timeout.
    const markdownCheck = (appDir) =>
      JSON.parse(runCli(["doctor", "--json"], { cwd: appDir }).stdout).checks.find((check) =>
        check.message.includes("Markdown route"),
      );
    const checks = {
      withPlugin: markdownCheck(withPlugin),
      withContentWithoutCompiler: markdownCheck(withContentWithoutCompiler),
      withContentRegistryOnly: markdownCheck(withContentRegistryOnly),
      withoutPlugin: markdownCheck(withoutPlugin),
    };
    const hasWarning = (key) => checks[key] !== undefined;

    // Paired: the negative case only means something next to a positive one in
    // the same shape, otherwise it passes with the feature deleted.
    expect(hasWarning("withoutPlugin")).toBe(true);
    expect(hasWarning("withPlugin")).toBe(false);
    // A content registry is not itself a Markdown compiler: empty collections,
    // collections without `module`, and collections that do not own this route
    // all leave the raw source for Vite's JavaScript parser.
    expect(hasWarning("withContentWithoutCompiler")).toBe(true);
    expect(hasWarning("withContentRegistryOnly")).toBe(true);

    // The registry cannot be resolved from config text, so the warning stays.
    // Its wording must not keep asserting these routes are broken, though: for
    // a collection that does own them the claim is simply false, and `pracht
    // build` is where the registry is actually resolved.
    expect(checks.withContentWithoutCompiler.message).toContain("`prachtContent()`");
    expect(checks.withContentWithoutCompiler.message).toContain("configured");
    expect(checks.withContentWithoutCompiler.message).not.toContain("rendered by");
    expect(checks.withContentWithoutCompiler.message).toContain("`pracht build`");
    expect(checks.withoutPlugin.message).toContain("no known Markdown transform plugin");
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
  routes: [route("/guide", "./routes/guide.markdown", { id: "guide", render: "ssg" })],
});
`,
    });
    writeProjectFile(appDir, "src/routes/guide.markdown", "# Guide\n");

    const report = JSON.parse(runCli(["doctor", "--json"], { cwd: appDir }).stdout);

    expect(
      report.checks.some(
        (check) =>
          check.status === "warning" && check.message.includes("src/routes/guide.markdown"),
      ),
    ).toBe(true);
  });
});
