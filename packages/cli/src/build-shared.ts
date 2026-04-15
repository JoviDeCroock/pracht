import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_SECURITY_HEADERS, VERSION } from "./constants.js";

const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";

interface HeaderSettable {
  setHeader(key: string, value: string): void;
}

export function setDefaultSecurityHeaders(
  res: HeaderSettable,
  headers: Record<string, string> = {},
): void {
  for (const [key, value] of Object.entries({
    ...DEFAULT_SECURITY_HEADERS,
    ...headers,
  })) {
    res.setHeader(key, value);
  }
}

interface VercelBuildOutputOptions {
  functionName?: string;
  headersManifest?: Record<string, Record<string, string>>;
  isgRoutes: string[];
  regions?: string[];
  root: string;
  staticRoutes: string[];
}

export function writeVercelBuildOutput({
  functionName,
  headersManifest = {},
  isgRoutes,
  regions,
  root,
  staticRoutes,
}: VercelBuildOutputOptions): string {
  const outputDir = join(root, ".vercel/output");
  const staticDir = join(outputDir, "static");
  const functionDir = join(outputDir, "functions", `${functionName || "render"}.func`);

  rmSync(outputDir, { force: true, recursive: true });
  mkdirSync(outputDir, { recursive: true });
  cpSync(join(root, "dist/client"), staticDir, { recursive: true });
  cpSync(join(root, "dist/server"), functionDir, { recursive: true });

  writeFileSync(
    join(outputDir, "config.json"),
    `${JSON.stringify(
      createVercelOutputConfig({ functionName, headersManifest, staticRoutes, isgRoutes }),
      null,
      2,
    )}\n`,
    "utf-8",
  );
  writeFileSync(
    join(functionDir, ".vc-config.json"),
    `${JSON.stringify(createVercelFunctionConfig({ regions }), null, 2)}\n`,
    "utf-8",
  );

  return ".vercel/output";
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
  ];

  for (const route of sortStaticRoutes(staticRoutes)) {
    routes.push({
      dest: routeToStaticHtmlPath(route),
      src: routeToRouteExpression(route),
    });
  }

  for (const route of isgRoutes) {
    routes.push({
      dest: target,
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

function routeToHeaderSource(route: string): string {
  return route === "/" ? "/" : route;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}
