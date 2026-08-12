import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { getTimeRevalidateSeconds, type ISGManifestEntry } from "@pracht/core/server";
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
const VERCEL_NODE_ENTRY_FILE = "_pracht-node-entry.cjs";
const VERCEL_NODE_ENTRY_SOURCE = `let listener;

module.exports = async (req, res) => {
  listener ??= (await import("./server.js")).nodeListener;
  return listener(req, res);
};
`;

type VercelRegions = string | string[];

/**
 * The headers `applyDefaultSecurityHeaders()` puts on every framework
 * response. Output served by the platform never reaches that code, so each
 * build target that emits its own header configuration replays them here.
 */
export const PRACHT_BASELINE_SECURITY_HEADERS: readonly (readonly [string, string])[] = [
  [
    "permissions-policy",
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  ],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "SAMEORIGIN"],
];

/**
 * Entity headers the platform derives from the file it serves. Replaying a
 * build-time value would let it drift from the bytes on disk.
 */
const HOST_OWNED_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "content-type",
  "date",
  "etag",
  "last-modified",
  "transfer-encoding",
]);

/**
 * Narrow a prerendered response's headers to the ones a host configuration
 * should replay: what the app's `headers()` exports asked for, minus anything
 * the host owns and minus baseline values already applied to every path.
 */
export function publishableDocumentHeaders(
  headers: Record<string, string> | undefined,
  options: { dropAcceptVary?: boolean; dropRouteStateVary?: boolean } = {},
): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (HOST_OWNED_HEADERS.has(name)) continue;
    // Runtime documents can vary by route-state header or negotiated media
    // type. A static deployment publishes one representation at the document
    // URL and route state at a separate file, so those tokens describe no
    // variance there. Preserve unrelated application-owned Vary tokens.
    if (name === "vary" && (options.dropRouteStateVary || options.dropAcceptVary)) {
      const dropped = new Set<string>();
      if (options.dropRouteStateVary) dropped.add(ROUTE_STATE_REQUEST_HEADER);
      if (options.dropAcceptVary) dropped.add("accept");
      const remaining = value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "" && !dropped.has(entry.toLowerCase()));
      if (remaining.length === 0) continue;
      result[key] = remaining.join(", ");
      continue;
    }
    const baseline = PRACHT_BASELINE_SECURITY_HEADERS.find(([header]) => header === name);
    if (baseline && baseline[1] === value) continue;
    result[key] = value;
  }

  return result;
}

interface VercelBuildOutputOptions {
  functionName?: string;
  headersManifest?: Record<string, Record<string, string>>;
  isgManifest: Record<string, ISGManifestEntry>;
  /** Prerendered routes whose module exports `markdown`. */
  markdownRoutes?: string[];
  revalidateToken?: string;
  regions?: VercelRegions;
  root: string;
  staticRoutes: string[];
}

export function writeVercelBuildOutput({
  functionName,
  headersManifest = {},
  isgManifest,
  markdownRoutes = [],
  revalidateToken = process.env.PRACHT_REVALIDATE_TOKEN || randomBytes(32).toString("hex"),
  regions,
  root,
  staticRoutes,
}: VercelBuildOutputOptions): string {
  const outputDir = join(root, ".vercel/output");
  const staticDir = join(outputDir, "static");
  const functionsDir = join(outputDir, "functions");
  const resolvedFunctionName = functionName || "render";
  const functionDir = join(functionsDir, `${resolvedFunctionName}.func`);

  assertNoVercelPrerenderFunctionCollisions({
    functionDir,
    functionName: resolvedFunctionName,
    functionsDir,
    isgRoutes: Object.keys(isgManifest),
  });

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
    regions,
    revalidateToken,
    staticDir,
  });

  writeFileSync(
    join(outputDir, "config.json"),
    `${JSON.stringify(
      createVercelOutputConfig({
        functionName,
        headersManifest,
        markdownRoutes,
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

function assertNoVercelPrerenderFunctionCollisions({
  functionDir,
  functionName,
  functionsDir,
  isgRoutes,
}: {
  functionDir: string;
  functionName: string;
  functionsDir: string;
  isgRoutes: string[];
}): void {
  for (const route of isgRoutes) {
    const prerenderName = routeToPrerenderFunctionName(route);
    const routeFunctionDir = join(functionsDir, `${prerenderName}.func`);
    if (routeFunctionDir !== functionDir) continue;

    throw new Error(
      `Cannot emit Vercel ISG route ${JSON.stringify(route)} because its prerender function ${JSON.stringify(`${prerenderName}.func`)} collides with the main edge function ${JSON.stringify(`${functionName}.func`)}. Rename the route or configure vercelAdapter({ functionName: "..." }) with a non-conflicting name.`,
    );
  }
}

function writeVercelPrerenderFunctions({
  functionDir,
  functionsDir,
  headersManifest,
  isgManifest,
  regions,
  revalidateToken,
  staticDir,
}: {
  functionDir: string;
  functionsDir: string;
  headersManifest: Record<string, Record<string, string>>;
  isgManifest: Record<string, ISGManifestEntry>;
  regions?: VercelRegions;
  revalidateToken: string;
  staticDir: string;
}): void {
  // The first ISG route materializes the Node function; the rest symlink to it
  // so that N ISG paths don't each duplicate the server bundle.
  let sharedNodeFunctionDir: string | undefined;

  for (const [route, entry] of Object.entries(isgManifest)) {
    const prerenderName = routeToPrerenderFunctionName(route);
    const routeFunctionDir = join(functionsDir, `${prerenderName}.func`);
    if (sharedNodeFunctionDir) {
      linkVercelPrerenderFunction({ routeFunctionDir, sharedNodeFunctionDir });
    } else {
      writeVercelPrerenderFunction({ functionDir, regions, routeFunctionDir });
      sharedNodeFunctionDir = routeFunctionDir;
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

/**
 * Emit the Serverless Function ISG routes render through. It gets its own copy
 * of the server bundle rather than linking to the edge function's: Node
 * resolves a symlinked module at its real path, so a linked `server.js` would
 * be typed by the edge function directory — which carries no ESM
 * `package.json` — and fail to parse as CommonJS.
 */
function writeVercelPrerenderFunction({
  functionDir,
  regions,
  routeFunctionDir,
}: {
  functionDir: string;
  regions?: VercelRegions;
  routeFunctionDir: string;
}): void {
  mkdirSync(dirname(routeFunctionDir), { recursive: true });
  cpSync(functionDir, routeFunctionDir, { recursive: true });

  // The bundle is ESM and Vite emits no `package.json` beside it, so without
  // this Node would load `server.js` as CommonJS and fail to parse it.
  writeFileSync(
    join(routeFunctionDir, "package.json"),
    `${JSON.stringify({ type: "module" }, null, 2)}\n`,
    "utf-8",
  );
  writeFileSync(join(routeFunctionDir, VERCEL_NODE_ENTRY_FILE), VERCEL_NODE_ENTRY_SOURCE, "utf-8");
  writeFileSync(
    join(routeFunctionDir, ".vc-config.json"),
    `${JSON.stringify(createVercelNodeFunctionConfig({ regions }), null, 2)}\n`,
    "utf-8",
  );
}

function linkVercelPrerenderFunction({
  routeFunctionDir,
  sharedNodeFunctionDir,
}: {
  routeFunctionDir: string;
  sharedNodeFunctionDir: string;
}): void {
  mkdirSync(dirname(routeFunctionDir), { recursive: true });
  // Vercel resolves symlinked `.func` directories; fall back to a copy where
  // symlinks aren't available (e.g. Windows without the required privileges).
  try {
    symlinkSync(
      relative(dirname(routeFunctionDir), sharedNodeFunctionDir),
      routeFunctionDir,
      "dir",
    );
  } catch {
    cpSync(sharedNodeFunctionDir, routeFunctionDir, { recursive: true });
  }
}

// `has.value` is compiled without the `i` flag, so case-insensitivity has to be
// written out. Media types are case-insensitive per RFC 9110, and the runtime's
// own negotiation lowercases before comparing — a client sending
// `Accept: TEXT/MARKDOWN` must not get a different answer on Vercel than it
// gets on Node or Cloudflare.
const ACCEPT_MARKDOWN_PATTERN = ".*[tT][eE][xX][tT]/[mM][aA][rR][kK][dD][oO][wW][nN].*";

function createVercelOutputConfig({
  functionName,
  headersManifest,
  markdownRoutes,
  staticRoutes,
  isgRoutes,
}: {
  functionName?: string;
  headersManifest: Record<string, Record<string, string>>;
  markdownRoutes: string[];
  isgRoutes: string[];
  staticRoutes: string[];
}): Record<string, unknown> {
  const target = `/${functionName || "render"}`;
  const routes: Record<string, unknown>[] = [
    // Headers have to be route entries. A top-level `headers` key in
    // `config.json` is accepted by the schema and then never applied, so
    // platform-served responses (static documents, assets) would carry none of
    // pracht's defaults. `continue: true` keeps the request flowing to the
    // rewrite or function that answers it.
    {
      continue: true,
      headers: Object.fromEntries(PRACHT_BASELINE_SECURITY_HEADERS),
      src: "/(.*)",
    },
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
    // Document headers belong only to HTML/static responses. Keep them after
    // both route-state dispatch rules so a public document Cache-Control value
    // can never replace the runtime's no-store/private policy on loader JSON.
    ...documentHeaderRoutes(staticRoutes, headersManifest),
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
  const markdownRouteEntry = (route: string) => ({
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

  return {
    framework: {
      version: VERSION,
    },
    routes,
    version: 3,
  };
}

/**
 * Replay each prerendered route's document headers. Vercel serves those files
 * from its CDN, so the framework never runs to apply what the route's
 * `headers()` export asked for.
 */
function documentHeaderRoutes(
  staticRoutes: string[],
  headersManifest: Record<string, Record<string, string>>,
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const route of sortStaticRoutes(staticRoutes)) {
    const routeHeaders = publishableDocumentHeaders(headersManifest[route]);
    if (Object.keys(routeHeaders).length === 0) continue;
    entries.push({
      continue: true,
      headers: routeHeaders,
      src: routeToRouteExpression(route),
    });
  }
  return entries;
}

function createVercelFunctionConfig({
  regions,
}: {
  regions?: VercelRegions;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {
    entrypoint: "server.js",
    runtime: "edge",
  };

  if (regions) {
    config.regions = regions;
  }

  return config;
}

function createVercelNodeFunctionConfig({
  regions,
}: {
  regions?: VercelRegions;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {
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

export function sortStaticRoutes(routes: string[]): string[] {
  return [...new Set(routes)].sort((left, right) => right.length - left.length);
}

export function routeToRouteExpression(route: string): string {
  if (route === "/") {
    return "^/$";
  }

  return `^${escapeRegex(route)}/?$`;
}

export function routeToStaticHtmlPath(route: string): string {
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

export function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
}
