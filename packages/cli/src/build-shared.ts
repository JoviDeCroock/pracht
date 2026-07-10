import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { getTimeRevalidateSeconds, type ISGManifestEntry } from "@pracht/core/server";
import { VERSION } from "./constants.js";

const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";

interface VercelBuildOutputOptions {
  functionName?: string;
  headersManifest?: Record<string, Record<string, string>>;
  isgManifest: Record<string, ISGManifestEntry>;
  revalidateToken?: string;
  regions?: string[];
  root: string;
  staticRoutes: string[];
}

export function writeVercelBuildOutput({
  functionName,
  headersManifest = {},
  isgManifest,
  revalidateToken = process.env.PRACHT_REVALIDATE_TOKEN || randomBytes(32).toString("hex"),
  regions,
  root,
  staticRoutes,
}: VercelBuildOutputOptions): string {
  const outputDir = join(root, ".vercel/output");
  const staticDir = join(outputDir, "static");
  const functionsDir = join(outputDir, "functions");
  const functionDir = join(outputDir, "functions", `${functionName || "render"}.func`);

  rmSync(outputDir, { force: true, recursive: true });
  mkdirSync(outputDir, { recursive: true });
  cpSync(join(root, "dist/client"), staticDir, { recursive: true });
  cpSync(join(root, "dist/server"), functionDir, { recursive: true });
  writeFileSync(
    join(functionDir, ".vc-config.json"),
    `${JSON.stringify(createVercelFunctionConfig({ regions }), null, 2)}\n`,
    "utf-8",
  );
  writeVercelPrerenderFunctions({
    functionDir,
    functionsDir,
    headersManifest,
    isgManifest,
    revalidateToken,
    staticDir,
  });

  writeFileSync(
    join(outputDir, "config.json"),
    `${JSON.stringify(
      createVercelOutputConfig({
        functionName,
        headersManifest,
        staticRoutes,
        isgRoutes: Object.keys(isgManifest),
      }),
      null,
      2,
    )}\n`,
    "utf-8",
  );

  return ".vercel/output";
}

function writeVercelPrerenderFunctions({
  functionDir,
  functionsDir,
  headersManifest,
  isgManifest,
  revalidateToken,
  staticDir,
}: {
  functionDir: string;
  functionsDir: string;
  headersManifest: Record<string, Record<string, string>>;
  isgManifest: Record<string, ISGManifestEntry>;
  revalidateToken: string;
  staticDir: string;
}): void {
  for (const [route, entry] of Object.entries(isgManifest)) {
    const prerenderName = routeToPrerenderFunctionName(route);
    const routeFunctionDir = join(functionsDir, `${prerenderName}.func`);
    if (routeFunctionDir !== functionDir) {
      mkdirSync(dirname(routeFunctionDir), { recursive: true });
      // Symlink rather than copy so that N ISG routes don't each duplicate the
      // full server bundle. Vercel resolves symlinked `.func` directories; fall
      // back to a copy where symlinks aren't available (e.g. Windows without
      // the required privileges).
      try {
        symlinkSync(relative(dirname(routeFunctionDir), functionDir), routeFunctionDir, "dir");
      } catch {
        cpSync(functionDir, routeFunctionDir, { recursive: true });
      }
    }

    const configPath = join(functionsDir, `${prerenderName}.prerender-config.json`);
    const fallbackName = `${basename(prerenderName)}.prerender-fallback.html`;
    const fallbackPath = join(dirname(configPath), fallbackName);
    const staticHtmlPath = join(staticDir, routeToStaticHtmlPath(route).slice(1));
    if (existsSync(staticHtmlPath)) {
      mkdirSync(dirname(fallbackPath), { recursive: true });
      cpSync(staticHtmlPath, fallbackPath);
      rmSync(staticHtmlPath, { force: true });
    }

    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          allowQuery: [],
          bypassToken: revalidateToken,
          expiration: getTimeRevalidateSeconds(entry.revalidate) ?? false,
          fallback: existsSync(fallbackPath) ? fallbackName : undefined,
          initialHeaders: headersManifest[route],
          initialStatus: 200,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  }
}

function createVercelOutputConfig({
  functionName,
  headersManifest,
  staticRoutes,
  isgRoutes,
}: {
  functionName?: string;
  headersManifest: Record<string, Record<string, string>>;
  isgRoutes: string[];
  staticRoutes: string[];
}): Record<string, unknown> {
  const target = `/${functionName || "render"}`;
  const routes: Record<string, unknown>[] = [
    {
      dest: target,
      has: [{ type: "header", key: ROUTE_STATE_REQUEST_HEADER, value: "1" }],
      src: "/(.*)",
    },
    {
      dest: target,
      has: [{ type: "query", key: "_data", value: "1" }],
      src: "/(.*)",
    },
  ];

  for (const route of sortStaticRoutes(staticRoutes)) {
    routes.push({
      dest: routeToStaticHtmlPath(route),
      src: routeToRouteExpression(route),
    });
  }

  for (const route of isgRoutes) {
    routes.push({
      dest: route,
      src: routeToRouteExpression(route),
    });
  }

  routes.push({ handle: "filesystem" });
  routes.push({ dest: target, src: "/(.*)" });

  const headers: Record<string, unknown>[] = [
    {
      headers: [
        {
          key: "permissions-policy",
          value:
            "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
        },
        { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
        { key: "x-content-type-options", value: "nosniff" },
        { key: "x-frame-options", value: "SAMEORIGIN" },
      ],
      source: "/(.*)",
    },
  ];

  for (const route of sortStaticRoutes(staticRoutes)) {
    const routeHeaders = headersManifest[route];
    if (!routeHeaders) continue;
    headers.push({
      headers: Object.entries(routeHeaders).map(([key, value]) => ({ key, value })),
      source: routeToHeaderSource(route),
    });
  }

  return {
    headers,
    framework: {
      version: VERSION,
    },
    routes,
    version: 3,
  };
}

function createVercelFunctionConfig({ regions }: { regions?: string[] }): Record<string, unknown> {
  const config: Record<string, unknown> = {
    entrypoint: "server.js",
    runtime: "edge",
  };

  if (regions) {
    config.regions = regions;
  }

  return config;
}

function sortStaticRoutes(routes: string[]): string[] {
  return [...new Set(routes)].sort((left, right) => right.length - left.length);
}

function routeToRouteExpression(route: string): string {
  if (route === "/") {
    return "^/$";
  }

  return `^${escapeRegex(route)}/?$`;
}

function routeToStaticHtmlPath(route: string): string {
  if (route === "/") {
    return "/index.html";
  }

  return `${route}/index.html`;
}

function routeToPrerenderFunctionName(route: string): string {
  return route === "/" ? "index" : route.replace(/^\/+/, "");
}

function basename(value: string): string {
  const segments = value.split("/");
  return segments[segments.length - 1] || "index";
}

function routeToHeaderSource(route: string): string {
  return route === "/" ? "/" : route;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}
