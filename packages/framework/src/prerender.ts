import { DEFAULT_LOADER_TIMEOUT_MS, resolveApp } from "./app.ts";
import { withBase } from "./base.ts";
import { injectMarkdownAlternateLink, markdownFilePath } from "./markdown-files.ts";
import { buildPathFromSegments, normalizeRoutePath } from "./route-matching.ts";
import { isDangerousPrerenderHeader, normalizeRouteRevalidate } from "./revalidation.ts";
import { hasMarkdownRepresentation, MARKDOWN_MEDIA_TYPE } from "./runtime-negotiation.ts";
import { NOT_FOUND_ROUTE_ID, ROUTE_STATE_REQUEST_HEADER } from "./runtime-constants.ts";
import { routeNeedsServerFetch, routeNeedsShellData } from "./runtime-client-fetch.ts";
import {
  reportRequestError,
  type RouteErrorContext,
  type SerializedRouteError,
} from "./runtime-errors.ts";
import { buildHtmlDocument } from "./runtime-html.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import { handlePrachtRequest } from "./runtime.ts";
import type {
  HeadMetadata,
  ModuleRegistry,
  PrachtApp,
  ResolvedApiRoute,
  ResolvedRoute,
  RouteModule,
  RouteRevalidate,
} from "./types.ts";

export interface PrerenderResult {
  path: string;
  html: string;
  headers?: Record<string, string>;
  /** Whether the route declares a Markdown representation. */
  markdown: boolean;
  /**
   * Serialized route-state JSON for the path — the exact body the live
   * `x-pracht-route-state-request` endpoint would answer with. Captured only
   * for `staticExport` builds, and only for full-hydration SSG routes whose
   * loader or head metadata needs a build-time payload during client navigation.
   */
  routeState?: string;
  /** Whether this page is a `render: "spa"` shell (staticExport builds only). */
  spa?: boolean;
  /**
   * The page's Markdown file, when `markdownFiles` is enabled and the route
   * answered a build-time `Accept: text/markdown` request with a 200 Markdown
   * response. `path` is base-free and route-space (`/about.md`, `/index.md`
   * for the root); `html` then already links it with
   * `<link rel="alternate" type="text/markdown">`. `source` is absent when the
   * path already holds the page's Markdown (see `markdownFileExists`): the page
   * links that file and nothing is written.
   */
  markdownFile?: { path: string; source?: string };
}

export interface ISGManifestEntry {
  revalidate: RouteRevalidate;
  generatedAt?: number;
}

export interface PrerenderAppResult {
  pages: PrerenderResult[];
  isgManifest: Record<string, ISGManifestEntry>;
}

export interface PrerenderAppOptions {
  app: PrachtApp;
  registry?: ModuleRegistry;
  clientEntryUrl?: string;
  islandsEntryUrl?: string;
  /** Force the islands bootstrap for zero-island pages that own another projection. */
  islandsBootstrapRequired?: boolean;
  /**
   * The app's API routes. Prerendered pages are answered the way a server
   * answers them (an API route wins its path), and with
   * `client.islandsNavigation` their route table lists the API routes too.
   */
  apiRoutes?: ResolvedApiRoute[];
  /** Per-source-file CSS map produced by the vite plugin. */
  cssManifest?: Record<string, string[]>;
  /** Per-public-URL CSS content emitted when route CSS inlining is enabled. */
  cssContentManifest?: Record<string, string>;
  /** Per-source-file JS map produced by the vite plugin for modulepreload hints. */
  jsManifest?: Record<string, string[]>;
  /** Maximum number of pages rendered concurrently. Defaults to 10. */
  concurrency?: number;
  /**
   * Static-export mode (`@pracht/adapter-static`): additionally prerender
   * loaderless `render: "spa"` routes (their shell document), and capture SSG
   * loader state so the build can serialize it for client-side navigation.
   */
  staticExport?: boolean;
  /**
   * Also capture a `<path>.md` file for every SSG page whose route declares a
   * Markdown representation. The page is requested a second time with
   * `Accept: text/markdown` through the normal handler, so middleware decides
   * exactly as it does at runtime; only a 200 `text/markdown` answer becomes a
   * file. ISG pages are skipped (a static file would never revalidate), as are
   * pages whose Markdown path is owned by a route or an existing file.
   */
  markdownFiles?: boolean;
  /**
   * Whether a file already occupies a Markdown path (base-free, route-space,
   * e.g. `/about.md`) in the client output. `true` (a `public/` file, any other
   * artifact) means the page gets no Markdown file and no link, with a warning.
   * `"markdown"` means the file is a declared Markdown artifact for this page
   * (`rawContentArtifacts()` at `<path>.md`): nothing is written over it, and
   * the page links it without a warning.
   */
  markdownFileExists?: (markdownPath: string) => boolean | "markdown";
}

export async function prerenderApp(options: PrerenderAppOptions): Promise<PrerenderResult[]>;
export async function prerenderApp(
  options: PrerenderAppOptions & { withISGManifest: true },
): Promise<PrerenderAppResult>;
export async function prerenderApp(
  options: PrerenderAppOptions & { withISGManifest?: boolean },
): Promise<PrerenderResult[] | PrerenderAppResult> {
  // Work pages register with `waitUntil()` belongs to the build: nothing is
  // left running once it returns, so wait for all of it — including work that
  // registers more — before handing the pages back, whether or not rendering
  // succeeded. Each task arrives already guarded, so none of them reject.
  const backgroundWork: Promise<unknown>[] = [];
  try {
    return await prerenderAppPages(options, (task) => {
      backgroundWork.push(task);
    });
  } finally {
    while (backgroundWork.length > 0) {
      await Promise.allSettled(backgroundWork.splice(0));
    }
  }
}

async function prerenderAppPages(
  options: PrerenderAppOptions & { withISGManifest?: boolean },
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<PrerenderResult[] | PrerenderAppResult> {
  const resolved = resolveApp(options.app);
  const results: PrerenderResult[] = [];
  const isgManifest: Record<string, ISGManifestEntry> = {};
  const generatedAt = Date.now();
  let failedPrerenders = 0;
  let firstPrerenderError: unknown;
  let firstPrerenderPath: string | undefined;

  // Collect all work items first, then render in parallel batches
  const work: {
    pathname: string;
    render: string;
    revalidate?: RouteRevalidate;
    route: ResolvedRoute;
    /** Set when this page should try to emit a Markdown file. */
    markdownPath?: string;
    /** The Markdown path already holds this page's Markdown; link it only. */
    markdownExists?: boolean;
  }[] = [];
  for (const route of resolved.routes) {
    const render = route.render;
    if (
      render !== "ssg" &&
      render !== "isg" &&
      !(options.staticExport === true && render === "spa")
    ) {
      continue;
    }
    const paths = await collectSSGPaths(route, options.registry, options.staticExport === true);
    for (const pathname of paths) {
      if (render === "isg" && route.revalidate) {
        normalizeRouteRevalidate(route.revalidate);
      }
      work.push({ pathname, render, revalidate: route.revalidate, route });
    }
  }

  if (options.markdownFiles === true) {
    await planMarkdownFiles(work, resolved, options);
  }
  const declinedMarkdown: string[] = [];

  // The same request a markdown-preferring agent sends at runtime, through
  // the same handler: middleware that only negotiates for verified agents, or
  // that redirects, answers something other than 200 Markdown here and the
  // page simply gets no file.
  const renderMarkdownFile = async (
    url: URL,
    item: { pathname: string; markdownPath?: string },
    waitUntil: (promise: Promise<unknown>) => void,
  ): Promise<string | undefined> => {
    let markdownError: unknown;
    const response = await handlePrachtRequest({
      app: options.app,
      request: new Request(url, { method: "GET", headers: { accept: MARKDOWN_MEDIA_TYPE } }),
      registry: options.registry,
      clientEntryUrl: options.clientEntryUrl,
      islandsEntryUrl: options.islandsEntryUrl,
      islandsBootstrapRequired: options.islandsBootstrapRequired,
      apiRoutes: options.apiRoutes,
      cssManifest: options.cssManifest,
      cssContentManifest: options.cssContentManifest,
      jsManifest: options.jsManifest,
      waitUntil,
      onRouteError: (error, requestPath, context) => {
        if (reportBackgroundFailure(error, requestPath, context)) return;
        markdownError = error;
      },
    });
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (response.status === 200 && contentType.startsWith(MARKDOWN_MEDIA_TYPE)) {
      return response.text();
    }
    await response.body?.cancel();
    if (response.status >= 500) {
      console.warn(
        `  Warning: the Markdown request for SSG route "${item.pathname}" returned status ${response.status}; ` +
          `no ${item.markdownPath} file is written.` +
          describeRenderError(markdownError, options.app.loaderTimeoutMs),
      );
    } else if (response.status !== 200) {
      const location = response.headers.get("location");
      declinedMarkdown.push(
        `${item.pathname} (status ${response.status}${location ? `, redirect: ${location}` : ""})`,
      );
    }
    return undefined;
  };

  const concurrency = options.concurrency ?? 10;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error("prerenderApp({ concurrency }) expects a positive integer.");
  }

  for (let i = 0; i < work.length; i += concurrency) {
    const batch = work.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (item) => {
        // Work items are route paths; the request is the URL a visitor would
        // ask for, base included. `handlePrachtRequest` strips the base back
        // off for matching, and the serialized hydration state then carries
        // the same URL shape a client-side navigation produces.
        const url = new URL(withBase(item.pathname), "http://localhost");
        const request = new Request(url, { method: "GET" });

        // The rendered response hides server error details (that is the right
        // default for a served page), so capture the raw throw for the build
        // error below.
        let renderError: unknown;
        const [response, routeModule] = await Promise.all([
          handlePrachtRequest({
            app: options.app,
            request,
            registry: options.registry,
            clientEntryUrl: options.clientEntryUrl,
            islandsEntryUrl: options.islandsEntryUrl,
            islandsBootstrapRequired: options.islandsBootstrapRequired,
            apiRoutes: options.apiRoutes,
            cssManifest: options.cssManifest,
            cssContentManifest: options.cssContentManifest,
            jsManifest: options.jsManifest,
            waitUntil,
            onRouteError: (error, requestPath, context) => {
              if (reportBackgroundFailure(error, requestPath, context)) return;
              renderError = error;
            },
          }),
          resolveRegistryModule<RouteModule>(options.registry?.routeModules, item.route.file),
        ]);

        if (response.status !== 200) {
          if (options.staticExport === true) {
            const location = response.headers.get("location");
            const redirectDetail = location ? ` (redirect: ${location})` : "";
            throw new Error(
              `Static export failed to render ${item.render.toUpperCase()} route "${item.pathname}": ` +
                `document request returned status ${response.status}${redirectDetail}. ` +
                "A static build cannot preserve request-time redirects or failures; make the loader succeed at build time or use a serverful adapter." +
                describeRenderError(renderError, options.app.loaderTimeoutMs),
              renderError === undefined ? undefined : { cause: renderError },
            );
          }
          // A 5xx is never a routing decision. Skipping it ships a build whose
          // pages fall back to a live render that fails the same way for every
          // visitor — a broken middleware module turns the whole app into 500s
          // behind a green build.
          if (response.status >= 500) {
            throw new Error(
              `Failed to prerender ${item.render.toUpperCase()} route "${item.pathname}": ` +
                `document request returned status ${response.status}. ` +
                "Fix the loader, shell, or middleware that failed — the route would otherwise " +
                "fall back to a live render and return the same error to every visitor." +
                describeRenderError(renderError, options.app.loaderTimeoutMs),
              renderError === undefined ? undefined : { cause: renderError },
            );
          }
          console.warn(
            `  Warning: ${item.render.toUpperCase()} route "${item.pathname}" returned status ${response.status}, skipping.`,
          );
          failedPrerenders++;
          if (firstPrerenderError === undefined && renderError !== undefined) {
            firstPrerenderError = renderError;
            firstPrerenderPath = item.pathname;
          }
          return null;
        }

        if (options.staticExport === true) {
          const contentType = response.headers.get("content-type") ?? "";
          if (!contentType.toLowerCase().includes("text/html")) {
            throw new Error(
              `Static export failed to render ${item.render.toUpperCase()} route "${item.pathname}" as HTML ` +
                `(content-type: ${contentType || "missing"}). Page loaders must return serializable data instead of a successful non-HTML Response.`,
            );
          }
        }

        assertSafePrerenderHeaders(response.headers, item);

        let html = await response.text();

        let markdownFile: { path: string; source?: string } | undefined;
        if (item.markdownPath !== undefined && item.markdownExists === true) {
          markdownFile = { path: item.markdownPath };
          html = injectMarkdownAlternateLink(html, withBase(item.markdownPath));
        } else if (item.markdownPath !== undefined) {
          const source = await renderMarkdownFile(url, item, waitUntil);
          if (source !== undefined) {
            markdownFile = { path: item.markdownPath, source };
            html = injectMarkdownAlternateLink(html, withBase(item.markdownPath));
          }
        }

        // Static exports serialize SSG loader payloads to static JSON files so
        // client-side navigation can fetch it without a server. Rendering the
        // same request with the route-state header keeps the payload
        // byte-identical to what the live endpoint would answer. Islands and
        // no-hydration routes are skipped: they never load the client router,
        // so nothing ever fetches their state.
        let routeState: string | undefined;
        if (
          options.staticExport === true &&
          item.route.hydration !== "islands" &&
          item.route.hydration !== "none" &&
          (routeNeedsServerFetch(item.route) || routeNeedsShellData(item.route, false))
        ) {
          let stateError: unknown;
          const stateResponse = await handlePrachtRequest({
            app: options.app,
            request: new Request(url, {
              method: "GET",
              headers: { [ROUTE_STATE_REQUEST_HEADER]: "1" },
            }),
            registry: options.registry,
            waitUntil,
            onRouteError: (error, requestPath, context) => {
              if (reportBackgroundFailure(error, requestPath, context)) return;
              stateError = error;
            },
          });
          if (stateResponse.status === 200) {
            routeState = await stateResponse.text();
            try {
              const parsed = JSON.parse(routeState) as unknown;
              if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("expected a JSON object");
              }
            } catch {
              throw new Error(
                `Static export failed to serialize route state for "${item.pathname}": ` +
                  "route-state request returned invalid JSON. " +
                  "Page loaders must return serializable data instead of a custom route-state Response.",
              );
            }
          } else {
            if (options.staticExport === true) {
              const location = stateResponse.headers.get("location");
              const redirectDetail = location ? ` (redirect: ${location})` : "";
              throw new Error(
                `Static export failed to serialize route state for "${item.pathname}": ` +
                  `route-state request returned status ${stateResponse.status}${redirectDetail}. ` +
                  "Make the loader succeed at build time or use a serverful adapter." +
                  describeRenderError(stateError, options.app.loaderTimeoutMs),
                stateError === undefined ? undefined : { cause: stateError },
              );
            }
            console.warn(
              `  Warning: route-state render for "${item.pathname}" returned status ${stateResponse.status}; no static state file will be written.`,
            );
          }
        }

        return {
          headers: Object.fromEntries(response.headers),
          html,
          item,
          markdown: hasMarkdownRepresentation(item.route, routeModule),
          markdownFile,
          routeState,
        };
      }),
    );

    for (const result of batchResults) {
      if (!result) continue;
      results.push({
        path: result.item.pathname,
        html: result.html,
        headers: result.headers,
        markdown: result.markdown,
        ...(result.markdownFile !== undefined ? { markdownFile: result.markdownFile } : {}),
        ...(result.routeState !== undefined ? { routeState: result.routeState } : {}),
        ...(result.item.render === "spa" ? { spa: true } : {}),
      });
      if (result.item.render === "isg" && result.item.revalidate) {
        isgManifest[result.item.pathname] = {
          generatedAt,
          revalidate: result.item.revalidate,
        };
      }
    }
  }

  if (declinedMarkdown.length > 0) {
    console.warn(
      `  Note: no Markdown file for ${formatPathList(declinedMarkdown)}: the build-time ` +
        "`Accept: text/markdown` request did not return 200. The page still negotiates at runtime.",
    );
  }

  if (work.length > 0 && failedPrerenders === work.length) {
    const noun = failedPrerenders === 1 ? "render" : "renders";
    throw new Error(
      `No SSG/ISG pages were prerendered: all ${failedPrerenders} attempted ${noun} returned a non-200 response. ` +
        "Refusing to finish a build with empty prerender output. Fix the build-time loader or render failures, or move request-dependent routes to SSR." +
        (firstPrerenderPath === undefined
          ? ""
          : `\n\n  First failing route: "${firstPrerenderPath}".`) +
        describeRenderError(firstPrerenderError, options.app.loaderTimeoutMs),
      firstPrerenderError === undefined ? undefined : { cause: firstPrerenderError },
    );
  }

  if (options.withISGManifest) {
    return { pages: results, isgManifest };
  }

  return results;
}

/**
 * Decide, before anything renders, which SSG pages may write a Markdown file.
 *
 * A Markdown file is a static file: every adapter serves it ahead of the app,
 * so it must never take a URL something else answers. A page loses its file
 * when its Markdown path is a concrete page or an exact page/API route
 * (`/about.md` as a route), when an earlier page already claimed the same
 * case-insensitive path (`/` and `/index` both map to `/index.md`), or when a
 * file already exists there (`public/about.md`, a content artifact). Dynamic
 * routes do not count: a static file shadowing `/blog/:slug` for the one
 * value `hello.md` is the same trade every static asset already makes.
 */
async function planMarkdownFiles(
  work: {
    pathname: string;
    render: string;
    route: ResolvedRoute;
    markdownPath?: string;
    markdownExists?: boolean;
  }[],
  resolved: ReturnType<typeof resolveApp>,
  options: PrerenderAppOptions,
): Promise<void> {
  const owners = new Map<string, string>();
  const addOwner = (path: string, description: string) => {
    const key = portableMarkdownKey(path);
    if (!owners.has(key)) owners.set(key, description);
  };
  for (const route of resolved.routes) {
    if (!route.segments.some((s) => s.type === "param" || s.type === "catchall")) {
      addOwner(route.path, `the page route "${route.path}"`);
    }
  }
  for (const route of options.apiRoutes ?? []) {
    if (!route.segments.some((s) => s.type === "param" || s.type === "catchall")) {
      addOwner(route.path, `the API route "${route.path}"`);
    }
  }
  for (const item of work) addOwner(item.pathname, `the page "${item.pathname}"`);

  const modules = new Map<string, RouteModule | undefined>();
  const claimed = new Map<string, string>();
  const skipped: string[] = [];
  // The root claims `/index.md` ahead of a literal `/index` route, the same
  // order the dev server resolves that URL in.
  const candidates = [...work].sort(
    (left, right) => Number(right.pathname === "/") - Number(left.pathname === "/"),
  );
  for (const item of candidates) {
    if (item.render !== "ssg") continue;
    if (!modules.has(item.route.file)) {
      modules.set(
        item.route.file,
        await resolveRegistryModule<RouteModule>(options.registry?.routeModules, item.route.file),
      );
    }
    if (!hasMarkdownRepresentation(item.route, modules.get(item.route.file))) continue;

    const markdownPath = markdownFilePath(item.pathname);
    const key = portableMarkdownKey(markdownPath);
    const owner = owners.get(key) ?? claimed.get(key);
    if (owner !== undefined) {
      skipped.push(`${markdownPath} (already ${owner})`);
      continue;
    }
    const existing = options.markdownFileExists?.(markdownPath) ?? false;
    if (existing === true) {
      skipped.push(`${markdownPath} (a file already exists there)`);
      continue;
    }
    claimed.set(key, `the Markdown file of "${item.pathname}"`);
    item.markdownPath = markdownPath;
    if (existing === "markdown") item.markdownExists = true;
  }

  if (skipped.length > 0) {
    console.warn(
      `  Warning: not writing ${skipped.length === 1 ? "a Markdown file" : `${skipped.length} Markdown files`} ` +
        `because the path is taken: ${formatPathList(skipped)}. Rename the route or file to publish it.`,
    );
  }
}

/** Case- and encoding-insensitive key, so collisions match portable filesystems. */
function portableMarkdownKey(path: string): string {
  return normalizeRoutePath(path)
    .split("/")
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {}
      return decoded.normalize("NFC").toLowerCase();
    })
    .join("/");
}

/** Name a handful of entries and count the rest, so a large site's log stays short. */
function formatPathList(entries: string[]): string {
  const shown = entries.slice(0, 5).join(", ");
  return entries.length > 5 ? `${shown}, and ${entries.length - 5} more` : shown;
}

/**
 * A failed `waitUntil()` task says nothing about whether the page rendered, so
 * it must not become the render error a failed build reports. Log it the way a
 * served request would and tell the caller it was handled.
 */
function reportBackgroundFailure(
  error: unknown,
  requestPath: string,
  context: RouteErrorContext | undefined,
): boolean {
  if (context?.phase !== "waitUntil") return false;
  reportRequestError(undefined, error, requestPath, context);
  return true;
}

/**
 * Render errors are deliberately opaque in the response body, which leaves a
 * failing static build with a bare status and nothing to act on. Append the
 * real message so `pracht build` names the cause instead of only the symptom.
 */
export function describeRenderError(error: unknown, loaderTimeoutMs?: number): string {
  if (error === undefined || error === null) return "";
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim();
  const underlying = trimmed === "" ? "" : `\n\n  Underlying error: ${trimmed}`;
  return underlying + describeLoaderTimeout(error, loaderTimeoutMs);
}

/**
 * Prerendering runs loaders through the same request pipeline a served page
 * does, so it inherits the same `defineApp({ loaderTimeoutMs })` budget. A
 * budget tuned down for an edge runtime therefore fails the *build* for any
 * loader slower than it, and the raw abort says nothing about where the limit
 * came from.
 */
function describeLoaderTimeout(error: unknown, loaderTimeoutMs?: number): string {
  if (!isLoaderTimeout(error)) return "";
  return (
    `\n\n  The loader ran past the ${loaderTimeoutMs ?? DEFAULT_LOADER_TIMEOUT_MS} ms request budget and its signal aborted. ` +
    "Prerendering uses the same `defineApp({ loaderTimeoutMs })` budget as a served request; raise it, or make the loader " +
    "finish inside it, if the build needs longer than production does."
  );
}

function isLoaderTimeout(error: unknown): boolean {
  const named = error as { name?: unknown; cause?: { name?: unknown } } | null;
  // Fetch rejects with the signal's reason in some runtimes and with an
  // `AbortError` carrying it as `cause` in others.
  return named?.name === "TimeoutError" || named?.cause?.name === "TimeoutError";
}

function assertSafePrerenderHeaders(
  headers: Headers,
  item: { pathname: string; render: string },
): void {
  const dangerous = [...headers.keys()].filter(isDangerousPrerenderHeader);
  if (dangerous.length === 0) return;

  const names = dangerous.map((name) => `"${name}"`).join(", ");
  throw new Error(
    `Refusing to prerender ${item.render.toUpperCase()} route "${item.pathname}" because its document headers include ${names}. ` +
      "SSG/ISG document headers are serialized into public static output and replayed for every visitor. " +
      "Move cookies/authentication headers to API routes, loaders, middleware responses, or SSR-only routes.",
  );
}

async function collectSSGPaths(
  route: ResolvedRoute,
  registry?: ModuleRegistry,
  staticExport = false,
): Promise<string[]> {
  const hasDynamicSegments = route.segments.some(
    (s) => s.type === "param" || s.type === "catchall",
  );

  if (!hasDynamicSegments) {
    return [route.path];
  }

  // Dynamic route — must export getStaticPaths() to enumerate params
  const routeModule = await resolveRegistryModule<RouteModule>(registry?.routeModules, route.file);

  if (!routeModule?.getStaticPaths) {
    if (route.render === "spa") {
      // Only reachable in staticExport mode (spa routes are otherwise never
      // prerendered). Not prerendering a dynamic spa route is the expected
      // shape — but deep links to it then need the SPA fallback document.
      console.warn(
        `  Note: dynamic SPA route "${route.path}" has no getStaticPaths() export, so no document or state file is prerendered for it. ` +
          `In-app navigation renders it client-side (without loader data); deep links need staticAdapter({ fallback: "200.html" }) plus a host rewrite.`,
      );
    } else {
      if (staticExport) {
        throw new Error(
          `Static export cannot emit dynamic SSG route "${route.path}" because it has no getStaticPaths() export. ` +
            "Add getStaticPaths() to enumerate every output path or use a serverful adapter.",
        );
      }
      console.warn(
        `  Warning: ${(route.render ?? "ssg").toUpperCase()} route "${route.path}" has dynamic segments but no getStaticPaths() export, skipping.`,
      );
    }
    return [];
  }

  const paramSets = await routeModule.getStaticPaths();
  return paramSets.map((params) => buildPathFromSegments(route.segments, params));
}

/**
 * The static-export SPA fallback document (conventionally `200.html`).
 *
 * A static host configured to rewrite unmatched URLs to this file (GitHub
 * Pages cannot; Netlify/nginx/S3+CloudFront can) lets deep links to
 * non-prerendered paths — dynamic `render: "spa"` routes above all — boot the
 * client router, which resolves the real route from `window.location` (see
 * the `fallback` hydration-state marker). The body is deliberately empty:
 * this document is served for *any* URL, so no route- or shell-specific
 * markup can be correct here.
 *
 * `head` is likewise explicit metadata shared by every rewritten URL. The
 * build cannot run a route-specific `head()` function for an arbitrary path.
 *
 * `notFoundData` and `notFoundError` are copied from the already-rendered
 * `404.html` hydration state. If the fallback resolves an unknown URL instead
 * of a dynamic SPA route, the not-found component or error boundary therefore
 * sees its normal build-time state without executing the loader a second time.
 */
export function buildStaticFallbackHtml(
  options: {
    clientEntryUrl?: string;
    head?: HeadMetadata;
    notFoundData?: unknown;
    notFoundError?: SerializedRouteError | null;
  } = {},
): string {
  return buildHtmlDocument({
    head: options.head ?? {},
    body: "",
    hydrationState: {
      url: "/",
      routeId: NOT_FOUND_ROUTE_ID,
      data: options.notFoundData,
      error: options.notFoundError ?? null,
      pending: true,
      fallback: true,
    },
    clientEntryUrl: options.clientEntryUrl,
  });
}
