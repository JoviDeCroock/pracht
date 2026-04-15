import type { HttpMethod } from "@pracht/core";

export type { HttpMethod };

export const VERSION = "0.0.0";

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
