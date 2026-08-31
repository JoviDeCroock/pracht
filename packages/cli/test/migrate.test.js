import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeMigration,
  convertRouteSegments,
  formatMigrateReport,
  inferRenderMode,
  moduleNameFor,
} from "../src/migrate.ts";
import {
  cleanupTempDirs,
  createRepoTempDir,
  runCliStatus,
  writeProjectFile,
} from "./helpers/cli-fixtures.js";

afterEach(cleanupTempDirs);

/** A small App Router app covering the shapes the analyser has to decide about. */
function writeNextApp(appDir) {
  writeProjectFile(
    appDir,
    "package.json",
    JSON.stringify({ name: "acme", dependencies: { next: "16.2.0", react: "19.0.0" } }, null, 2),
  );

  writeProjectFile(
    appDir,
    "app/layout.tsx",
    `export default function RootLayout({ children }) {
  return <html><body>{children}</body></html>;
}`,
  );

  // No request-time data: the default, and the case a migration most wants
  // pushed to SSG rather than left on SSR.
  writeProjectFile(
    appDir,
    "app/page.tsx",
    `export default function Page() { return <h1>hi</h1>; }`,
  );

  writeProjectFile(
    appDir,
    "app/(marketing)/pricing/page.tsx",
    `export const revalidate = 3600;
export default function Page() { return <h1>pricing</h1>; }`,
  );

  writeProjectFile(
    appDir,
    "app/blog/[slug]/page.tsx",
    `import Image from "next/image";

export async function generateStaticParams() { return []; }

export default async function Page({ params }) {
  const post = await getPost(params.slug);
  return <Image src={post.hero} alt="" />;
}`,
  );

  writeProjectFile(
    appDir,
    "app/dashboard/layout.tsx",
    `export default function DashboardLayout({ children }) { return <main>{children}</main>; }`,
  );

  writeProjectFile(
    appDir,
    "app/dashboard/page.tsx",
    `import { cookies } from "next/headers";

export default async function Page() {
  const session = cookies().get("session");
  return <h1>{session?.value}</h1>;
}`,
  );

  writeProjectFile(
    appDir,
    "app/docs/[...path]/page.tsx",
    `export default function Page() { return <article />; }`,
  );

  writeProjectFile(
    appDir,
    "app/api/health/route.ts",
    `export async function GET() { return Response.json({ ok: true }); }
export async function POST() { return Response.json({ ok: true }); }`,
  );
}

describe("convertRouteSegments", () => {
  it("maps Next segment syntax onto pracht paths", () => {
    expect(convertRouteSegments([])).toEqual({ path: "/", unsupported: null });
    expect(convertRouteSegments(["blog", "[slug]"])).toEqual({
      path: "/blog/:slug",
      unsupported: null,
    });
    // Route groups organise files; they never appear in the URL.
    expect(convertRouteSegments(["(marketing)", "pricing"])).toEqual({
      path: "/pricing",
      unsupported: null,
    });
    expect(convertRouteSegments(["docs", "[...path]"])).toEqual({
      path: "/docs/*",
      unsupported: null,
    });
    // Private folders are excluded from routing by Next too.
    expect(convertRouteSegments(["_components", "about"])).toEqual({
      path: "/about",
      unsupported: null,
    });
  });

  it("refuses to guess at segment shapes pracht has no equivalent for", () => {
    expect(convertRouteSegments(["@modal", "photo"]).path).toBeNull();
    expect(convertRouteSegments(["shop", "[[...filters]]"]).path).toBeNull();
    expect(convertRouteSegments(["(.)photo"]).path).toBeNull();
    // A catch-all that is not the final segment cannot mean "the rest of the
    // path", so emitting `/*/edit` would silently change the route.
    expect(convertRouteSegments(["docs", "[...path]", "edit"]).path).toBeNull();
  });
});

describe("moduleNameFor", () => {
  it("names a route module after its segments, not its URL", () => {
    expect(moduleNameFor([])).toBe("home");
    expect(moduleNameFor(["blog", "[slug]"])).toBe("blog-slug");
    expect(moduleNameFor(["docs", "[...path]"])).toBe("docs-path");
    expect(moduleNameFor(["(marketing)", "pricing"])).toBe("pricing");
  });
});

describe("inferRenderMode", () => {
  it("reads Next's rendering signals in the order Next resolves them", () => {
    expect(inferRenderMode('export const dynamic = "force-dynamic";').render).toBe("ssr");
    expect(inferRenderMode('export const dynamic = "force-static";').render).toBe("ssg");
    expect(inferRenderMode("export const revalidate = 60;")).toMatchObject({
      render: "isg",
      revalidate: 60,
    });
    // `revalidate = 0` is Next's opt-out of caching, not a zero-second ISG
    // policy — reading it as ISG would cache a page that must never be cached.
    expect(inferRenderMode("export const revalidate = 0;").render).toBe("ssr");
    expect(inferRenderMode('import { cookies } from "next/headers";').render).toBe("ssr");
    expect(inferRenderMode("export async function generateStaticParams() {}").render).toBe("ssg");
    expect(inferRenderMode("export default function Page() {}").render).toBe("ssg");
  });

  it("prefers an explicit segment config over inferred request-time reads", () => {
    const source = `import { cookies } from "next/headers";
export const dynamic = "force-static";`;
    expect(inferRenderMode(source).render).toBe("ssg");
  });
});

describe("analyzeMigration", () => {
  it("derives routes, render modes, and shells from an App Router tree", () => {
    const appDir = createRepoTempDir("pracht-migrate-app-");
    writeNextApp(appDir);

    const report = analyzeMigration(appDir);

    expect(report.source).toMatchObject({ framework: "next", router: "app", appDir: "app" });

    const byPath = new Map(report.routes.map((route) => [route.path, route]));
    expect([...byPath.keys()].sort()).toEqual([
      "/",
      "/blog/:slug",
      "/dashboard",
      "/docs/*",
      "/pricing",
    ]);
    expect(byPath.get("/")).toMatchObject({ render: "ssg", shell: "root" });
    expect(byPath.get("/pricing")).toMatchObject({ render: "isg", revalidate: 3600 });
    expect(byPath.get("/blog/:slug")).toMatchObject({ render: "ssg" });
    expect(byPath.get("/dashboard")).toMatchObject({ render: "ssr", shell: "dashboard" });

    // API routes are discovered separately: they move to src/api/, not the manifest.
    expect(report.apiRoutes).toEqual([
      { file: "app/api/health/route.ts", path: "/api/health", methods: ["GET", "POST"] },
    ]);

    expect(report.shells.map((shell) => shell.name).sort()).toEqual(["dashboard", "root"]);
    expect(report.ok).toBe(true);
  });

  it("proposes a manifest that imports only what it uses", () => {
    const appDir = createRepoTempDir("pracht-migrate-manifest-");
    writeNextApp(appDir);

    const { manifest } = analyzeMigration(appDir);

    expect(manifest).toContain('import { defineApp, route, timeRevalidate } from "@pracht/core";');
    expect(manifest).toContain(
      'route("/pricing", () => import("./routes/pricing.tsx"), { render: "isg", revalidate: timeRevalidate(3600), shell: "root" }),',
    );
    expect(manifest).toContain('root: () => import("./shells/root.tsx"),');
    // The module name comes from the source segments, so a catch-all does not
    // collapse to a trailing dash.
    expect(manifest).toContain('import("./routes/docs-path.tsx")');
    expect(manifest).toContain("//   /api/health  GET, POST");
  });

  it("omits timeRevalidate when no route needs it", () => {
    const appDir = createRepoTempDir("pracht-migrate-no-isg-");
    writeProjectFile(appDir, "package.json", JSON.stringify({ dependencies: { next: "16.0.0" } }));
    writeProjectFile(appDir, "app/page.tsx", "export default function Page() { return null; }");

    const { manifest } = analyzeMigration(appDir);
    expect(manifest).toContain('import { defineApp, route } from "@pracht/core";');
    expect(manifest).not.toContain("timeRevalidate");
  });

  it("reports the pieces that need a decision instead of translating them", () => {
    const appDir = createRepoTempDir("pracht-migrate-findings-");
    writeNextApp(appDir);
    writeProjectFile(
      appDir,
      "middleware.ts",
      `export const config = { matcher: ["/dashboard/:path*"] };
export function middleware() {}`,
    );
    writeProjectFile(
      appDir,
      "app/@modal/photo/page.tsx",
      "export default function Page() { return null; }",
    );
    writeProjectFile(
      appDir,
      "app/actions.ts",
      `"use server";
export async function save() {}`,
    );
    writeProjectFile(
      appDir,
      "app/dashboard/loading.tsx",
      "export default function Loading() { return null; }",
    );

    const report = analyzeMigration(appDir);
    const codes = report.findings.map((finding) => finding.code);

    expect(codes).toContain("server-actions");
    expect(codes).toContain("unsupported-segment");
    expect(codes).toContain("root-middleware");
    expect(codes).toContain("nested-layouts");
    expect(codes).toContain("react-dependency");
    expect(codes).toContain("next-image");
    expect(codes).toContain("next-headers");
    expect(codes).toContain("async-component");
    expect(codes).toContain("loading-state");

    // A blocker means the tool could not translate something, so the run is
    // not "clean" — but nothing was written either way.
    // One composition decision per nested layout, not one per page beneath it:
    // both /dashboard and /dashboard/settings sit under the same two layouts.
    const nested = report.findings.filter((finding) => finding.code === "nested-layouts");
    expect(nested).toHaveLength(1);
    expect(nested[0].file).toBe("app/dashboard/layout.tsx");

    expect(report.ok).toBe(false);
    expect(
      report.findings.filter((finding) => finding.severity === "blocker").length,
    ).toBeGreaterThan(0);
  });

  it("does not advise islands for a directive Next requires", () => {
    const appDir = createRepoTempDir("pracht-migrate-mandatory-directive-");
    writeProjectFile(appDir, "package.json", JSON.stringify({ dependencies: { next: "16.0.0" } }));
    // Next requires error boundaries to be client components, so telling the
    // author to reconsider the directive is advice about a file they cannot
    // change.
    writeProjectFile(
      appDir,
      "app/error.tsx",
      `"use client";
export default function Error() { return null; }`,
    );
    writeProjectFile(
      appDir,
      "app/widget.tsx",
      `"use client";
export function Widget() { return null; }`,
    );

    const byFile = analyzeMigration(appDir).findings.filter(
      (finding) => finding.code === "use-client",
    );
    expect(byFile.map((finding) => finding.file)).toEqual(["app/widget.tsx"]);
  });

  it("flags next.config options that have no pracht equivalent", () => {
    const appDir = createRepoTempDir("pracht-migrate-config-");
    writeProjectFile(appDir, "package.json", JSON.stringify({ dependencies: { next: "16.0.0" } }));
    writeProjectFile(appDir, "app/page.tsx", "export default function Page() { return null; }");
    writeProjectFile(
      appDir,
      "next.config.ts",
      `export default {
  async redirects() { return []; },
  images: { remotePatterns: [] },
};`,
    );

    const finding = analyzeMigration(appDir).findings.find(
      (candidate) => candidate.code === "next-config",
    );
    expect(finding?.message).toBe("Configures redirects, images.");
  });

  it("lists routes by URL, with the ones needing a decision last", () => {
    const appDir = createRepoTempDir("pracht-migrate-order-");
    writeNextApp(appDir);
    writeProjectFile(
      appDir,
      "app/@modal/page.tsx",
      "export default function Page() { return null; }",
    );

    const paths = analyzeMigration(appDir).routes.map((route) => route.path);
    expect(paths).toEqual(["/", "/blog/:slug", "/dashboard", "/docs/*", "/pricing", null]);
  });

  it("does not mistake a directive inside a comment or a nested string for a real one", () => {
    const appDir = createRepoTempDir("pracht-migrate-directive-");
    writeProjectFile(appDir, "package.json", JSON.stringify({ dependencies: { next: "16.0.0" } }));
    writeProjectFile(
      appDir,
      "app/page.tsx",
      `// "use client"
export default function Page() {
  const label = "use server";
  return <p>{label}</p>;
}`,
    );

    const codes = analyzeMigration(appDir).findings.map((finding) => finding.code);
    expect(codes).not.toContain("use-client");
    expect(codes).not.toContain("server-actions");
  });

  it("says so plainly when the directory is not a Next.js project", () => {
    const appDir = createRepoTempDir("pracht-migrate-empty-");
    writeProjectFile(appDir, "package.json", JSON.stringify({ name: "not-next" }));

    const report = analyzeMigration(appDir);
    expect(report.source.framework).toBeNull();
    expect(report.findings.map((finding) => finding.code)).toContain("not-next");
    expect(report.ok).toBe(false);
  });

  it("points a Pages Router app at pracht's pages router rather than the manifest", () => {
    const appDir = createRepoTempDir("pracht-migrate-pages-");
    writeProjectFile(appDir, "package.json", JSON.stringify({ dependencies: { next: "14.0.0" } }));
    writeProjectFile(appDir, "pages/index.tsx", "export default function Page() { return null; }");

    const report = analyzeMigration(appDir);
    expect(report.source.router).toBe("pages");
    expect(report.findings.map((finding) => finding.code)).toContain("pages-router");
  });
});

describe("formatMigrateReport", () => {
  it("leads with the fact that nothing was written", () => {
    const appDir = createRepoTempDir("pracht-migrate-format-");
    writeNextApp(appDir);

    const output = formatMigrateReport(analyzeMigration(appDir));
    expect(output.split("\n")[0]).toBe("pracht migrate — analysis only, no files were changed.");
    expect(output).toContain("Proposed src/routes.ts");
    expect(output).toContain("/dashboard");
  });
});

describe("pracht migrate", () => {
  it("analyses a project without touching it", () => {
    const appDir = createRepoTempDir("pracht-migrate-cli-");
    writeNextApp(appDir);

    const before = analyzeMigration(appDir);
    const result = runCliStatus(["migrate"], { cwd: appDir });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no files were changed");
    expect(result.stdout).toContain("/blog/:slug");
    // The proof that it is read-only: a second analysis sees the same tree.
    expect(analyzeMigration(appDir)).toEqual(before);
  }, 60_000);

  it("exits non-zero when something has no mechanical translation", () => {
    const appDir = createRepoTempDir("pracht-migrate-cli-blocker-");
    writeProjectFile(appDir, "package.json", JSON.stringify({ dependencies: { next: "16.0.0" } }));
    writeProjectFile(
      appDir,
      "app/@modal/page.tsx",
      "export default function Page() { return null; }",
    );

    const result = runCliStatus(["migrate", "--json"], { cwd: appDir });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).ok).toBe(false);
  }, 60_000);
});
