import { VERSION } from "./constants.js";

const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";

/**
 * Vercel only accepts `.prerender-config.json` (ISR) next to a Serverless
 * Function — pairing one with an Edge Function fails the deployment with
 * `Unexpected function type "EdgeFunction"`. ISG routes therefore run on Node
 * while the main handler stays on the edge; both load the same Web-API-only
 * server bundle.
 */
const VERCEL_NODE_RUNTIME = "nodejs22.x";

/**
 * Named so it cannot collide with a chunk emitted into `dist/server`. It is
 * CommonJS (like Next.js' `___next_launcher.cjs`) so Vercel's Node launcher can
 * require it without relying on ES module interop; the ESM server bundle is
 * pulled in through a dynamic import.
 */
export const VERCEL_NODE_ENTRY_FILE = "_pracht-node-entry.cjs";
export const VERCEL_NODE_ENTRY_SOURCE = `let listener;

module.exports = async (req, res) => {
  listener ??= (await import("./server.js")).nodeListener;
  return listener(req, res);
};
`;

// `has.value` is compiled without the `i` flag, so case-insensitivity has to be
// written out. Media types are case-insensitive per RFC 9110, and the runtime's
// own negotiation lowercases before comparing — a client sending
// `Accept: TEXT/MARKDOWN` must not get a different answer on Vercel than it
// gets on Node or Cloudflare.
const ACCEPT_MARKDOWN_PATTERN = ".*[tT][eE][xX][tT]/[mM][aA][rR][kK][dD][oO][wW][nN].*";

export type VercelRegions = string | string[];

export interface VercelOutputConfigOptions {
  functionName?: string;
  headersManifest: Record<string, Record<string, string>>;
  isgRoutes: string[];
  markdownRoutes: string[];
  staticRoutes: string[];
}

export interface VercelOutputRoute {
  dest?: string;
  handle?: "filesystem";
  has?: { key: string; type: "header" | "query"; value: string }[];
  src?: string;
}

export interface VercelOutputHeaderRule {
  headers: { key: string; value: string }[];
  source: string;
}

export interface VercelOutputConfig {
  framework: { version: string };
  headers: VercelOutputHeaderRule[];
  routes: VercelOutputRoute[];
  version: 3;
}

export interface VercelFunctionConfig {
  entrypoint: "server.js";
  regions?: VercelRegions;
  runtime: "edge";
}

export interface VercelNodeFunctionConfig {
  handler: string;
  launcherType: "Nodejs";
  regions?: string[];
  runtime: string;
  shouldAddHelpers: false;
}

/** Build the pure Build Output API v3 routing and header document. */
export function createVercelOutputConfig({
  functionName,
  headersManifest,
  markdownRoutes,
  staticRoutes,
  isgRoutes,
}: VercelOutputConfigOptions): VercelOutputConfig {
  const target = `/${functionName || "render"}`;
  const routes: VercelOutputRoute[] = [
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

  // Routes that export `markdown` answer `Accept: text/markdown` with their
  // source instead of HTML, which only the function can do — so they have to
  // reach it before the static rewrite below claims them. Node and Cloudflare
  // make the same decision inside the adapter; on Vercel the routing table is
  // the adapter, and without this entry a markdown-preferring agent silently
  // gets HTML while `llms.txt` advertises markdown support.
  //
  // The header match is intentionally coarser than the runtime's negotiation:
  // `has` takes a regex, not a q-value parser. Anything mentioning
  // `text/markdown` is handed to the function, which then runs the real
  // `prefersMarkdown()` check and still answers HTML when HTML is preferred.
  //
  // The cost, stated plainly: on these routes a client can force a function
  // invocation by sending the header, even with `q=0`. It is bounded to routes
  // that actually export `markdown` — every other prerendered page keeps its
  // static fast path whatever the client asks for.
  const markdownRouteSet = new Set(markdownRoutes);
  const markdownRouteEntry = (route: string): VercelOutputRoute => ({
    dest: target,
    has: [{ type: "header", key: "accept", value: ACCEPT_MARKDOWN_PATTERN }],
    src: routeToRouteExpression(route),
  });

  for (const route of sortStaticRoutes(staticRoutes)) {
    if (markdownRouteSet.has(route)) routes.push(markdownRouteEntry(route));
    routes.push({
      dest: routeToStaticHtmlPath(route),
      src: routeToRouteExpression(route),
    });
  }

  for (const route of isgRoutes) {
    // ISG markdown routes go to the render function, not to their prerender
    // function: that one re-renders on a sanitized `Accept: text/html` to keep
    // the shared cache entry correct, so it can only ever produce HTML.
    if (markdownRouteSet.has(route)) routes.push(markdownRouteEntry(route));
    routes.push({
      dest: route,
      src: routeToRouteExpression(route),
    });
  }

  routes.push({ handle: "filesystem" });
  routes.push({ dest: target, src: "/(.*)" });

  const headers: VercelOutputHeaderRule[] = [
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

export function createVercelFunctionConfig({
  regions,
}: {
  regions?: VercelRegions;
}): VercelFunctionConfig {
  const config: VercelFunctionConfig = {
    entrypoint: "server.js",
    runtime: "edge",
  };

  if (regions) config.regions = regions;

  return config;
}

export function createVercelNodeFunctionConfig({
  regions,
}: {
  regions?: VercelRegions;
}): VercelNodeFunctionConfig {
  const config: VercelNodeFunctionConfig = {
    handler: VERCEL_NODE_ENTRY_FILE,
    launcherType: "Nodejs",
    runtime: VERCEL_NODE_RUNTIME,
    shouldAddHelpers: false,
  };

  // `all` is an Edge-only sentinel. Node functions must name concrete regions;
  // omitting the field lets the project-level Serverless default apply.
  if (regions && regions !== "all") {
    config.regions = Array.isArray(regions) ? regions : [regions];
  }

  return config;
}

export function routeToStaticHtmlPath(route: string): string {
  return route === "/" ? "/index.html" : `${route}/index.html`;
}

export function routeToPrerenderFunctionName(route: string): string {
  return route === "/" ? "index" : route.replace(/^\/+/, "");
}

function sortStaticRoutes(routes: string[]): string[] {
  return [...new Set(routes)].sort((left, right) => right.length - left.length);
}

function routeToRouteExpression(route: string): string {
  return route === "/" ? "^/$" : `^${escapeRegex(route)}/?$`;
}

function routeToHeaderSource(route: string): string {
  return route === "/" ? "/" : route;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}
