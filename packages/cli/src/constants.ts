import { readFileSync } from "node:fs";
import type { HttpMethod } from "@pracht/core";

export type { HttpMethod };

export const VERSION = readPackageVersion();

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { version?: string };
    return packageJson.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const PROJECT_DEFAULTS = {
  apiDir: "/src/api",
  appFile: "/src/routes.ts",
  middlewareDir: "/src/middleware",
  pagesDefaultRender: "ssr",
  pagesDir: "",
  routesDir: "/src/routes",
  serverDir: "/src/server",
  shellsDir: "/src/shells",
};

export const HTTP_METHODS = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
