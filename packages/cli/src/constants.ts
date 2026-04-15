export const DEFAULT_SECURITY_HEADERS: Record<string, string> = {
  "permissions-policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
};

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

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export const HTTP_METHODS = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
