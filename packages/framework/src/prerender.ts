import { resolveApp } from "./app.ts";
import { buildPathFromSegments } from "./route-matching.ts";
import { isDangerousPrerenderHeader, normalizeRouteRevalidate } from "./revalidation.ts";
import { routeNeedsServerFetch } from "./runtime-client-fetch.ts";
import { NOT_FOUND_PRERENDER_PATH } from "./runtime-constants.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import { handlePrachtRequest } from "./runtime.ts";
import type {
  ModuleRegistry,
  PrachtApp,
  ResolvedRoute,
  RouteModule,
  RouteParams,
  RouteRevalidate,
} from "./types.ts";

export interface PrerenderResult {
  path: string;
  html: string;
  headers?: Record<string, string>;
  /** Whether the route module exports a raw Markdown representation. */
  markdown: boolean;
  /** The mode that produced this document. */
  render?: "ssg" | "isg" | "spa" | "not-found";
  /** Route id, when the route declares one. */
  routeId?: string;
  /**
   * Route pattern this document is the fallback for. Set on dynamic SPA
   * routes, whose single document answers every URL matching the pattern —
   * `path` is then a placeholder used only to drive the render.
   */
  fallbackFor?: string;
  /**
   * The route-state JSON a client navigation to `path` would have fetched,
   * captured at build time. Only present when `includeRouteState` is enabled
   * and the route actually needs one.
   */
  routeState?: string;
}

export interface ISGManifestEntry {
  revalidate: RouteRevalidate;
  generatedAt?: number;
}

export interface PrerenderAppResult {
  pages: PrerenderResult[];
  isgManifest: Record<string, ISGManifestEntry>;
  /** The app's `notFound` page, rendered when `includeNotFound` is enabled. */
  notFound?: PrerenderResult;
}

export interface PrerenderAppOptions {
  app: PrachtApp;
  registry?: ModuleRegistry;
  clientEntryUrl?: string;
  islandsEntryUrl?: string;
  /** Force the islands bootstrap for zero-island pages that own another projection. */
  islandsBootstrapRequired?: boolean;
  /** Per-source-file CSS map produced by the vite plugin. */
  cssManifest?: Record<string, string[]>;
  /** Per-source-file JS map produced by the vite plugin for modulepreload hints. */
  jsManifest?: Record<string, string[]>;
  /** Maximum number of pages rendered concurrently. Defaults to 10. */
  concurrency?: number;
  /**
   * Also emit `render: "spa"` documents. A static host has no runtime to
   * render the shell on demand, so the shell + `Loading()` placeholder is
   * written out at build time: once per concrete path, or once as a fallback
   * for a route with dynamic segments.
   */
  includeSpa?: boolean;
  /**
   * Also capture the route-state JSON each emitted path would serve, so a
   * client navigation on a static host reads a build-time snapshot instead of
   * calling a route-state endpoint that does not exist.
   */
  includeRouteState?: boolean;
  /** Also render the app's `notFound` page (as a 404 fallback document). */
  includeNotFound?: boolean;
  /** Fail instead of skipping a dynamic SSG route without `getStaticPaths()`. */
  requireStaticPaths?: boolean;
}

export async function prerenderApp(options: PrerenderAppOptions): Promise<PrerenderResult[]>;
export async function prerenderApp(
  options: PrerenderAppOptions & { withISGManifest: true },
): Promise<PrerenderAppResult>;
export async function prerenderApp(
  options: PrerenderAppOptions & { withISGManifest?: boolean },
): Promise<PrerenderResult[] | PrerenderAppResult> {
  const resolved = resolveApp(options.app);
  const results: PrerenderResult[] = [];
  const isgManifest: Record<string, ISGManifestEntry> = {};
  const generatedAt = Date.now();

  // Collect all work items first, then render in parallel batches
  const work: PrerenderWorkItem[] = [];
  for (const route of resolved.routes) {
    if (route.render === "spa") {
      if (!options.includeSpa) continue;
      // A dynamic SPA route resolves entirely in the browser, so one document
      // answers every URL under the pattern. `getStaticPaths()` is not
      // consulted: enumerating client-rendered shells would emit N identical
      // files.
      const fallbackFor = hasDynamicSegments(route) ? route.path : undefined;
      work.push({
        pathname: fallbackFor === undefined ? route.path : buildSpaFallbackPath(route),
        render: "spa",
        route,
        fallbackFor,
      });
      continue;
    }

    if (route.render !== "ssg" && route.render !== "isg") continue;
    const paths = await collectSSGPaths(route, options.registry, options.requireStaticPaths);
    for (const pathname of paths) {
      if (route.render === "isg" && route.revalidate) {
        normalizeRouteRevalidate(route.revalidate);
      }
      work.push({ pathname, render: route.render, revalidate: route.revalidate, route });
    }
  }

  const concurrency = options.concurrency ?? 10;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error("prerenderApp({ concurrency }) expects a positive integer.");
  }

  for (let i = 0; i < work.length; i += concurrency) {
    const batch = work.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (item) => {
        const url = new URL(item.pathname, "http://localhost");
        const request = new Request(url, { method: "GET" });
        // A fallback document is served for every URL matching its pattern,
        // so the render must not bake in the placeholder path it used.
        const isFallback = item.fallbackFor !== undefined;
        // Islands and no-hydration pages never load the client router — it
        // navigates to them with a full document load — so a snapshot for one
        // could never be fetched, and writing it would publish the loader's
        // whole return value as a public file the document never contained.
        const needsRouteState =
          options.includeRouteState &&
          !isFallback &&
          (item.route.hydration ?? "full") === "full" &&
          routeNeedsServerFetch(item.route);
        let routeState: string | undefined;

        const [response, routeModule] = await Promise.all([
          handlePrachtRequest({
            app: options.app,
            request,
            registry: options.registry,
            clientEntryUrl: options.clientEntryUrl,
            islandsEntryUrl: options.islandsEntryUrl,
            islandsBootstrapRequired: options.islandsBootstrapRequired,
            cssManifest: options.cssManifest,
            jsManifest: options.jsManifest,
            fallbackDocument: isFallback,
            omitRouteHead: isFallback,
            ...(needsRouteState
              ? {
                  captureRouteState(json: string) {
                    routeState = json;
                  },
                }
              : {}),
          }),
          resolveRegistryModule<RouteModule>(options.registry?.routeModules, item.route.file),
        ]);

        if (response.status !== 200) {
          if (needsRouteState) {
            throw new Error(
              `Cannot emit static route state for "${item.pathname}": the document request ` +
                `returned status ${response.status}. Static client navigation has no server fallback.`,
            );
          }
          console.warn(
            `  Warning: ${item.render.toUpperCase()} route "${item.pathname}" returned status ${response.status}, skipping.`,
          );
          return null;
        }

        if (needsRouteState && routeState === undefined) {
          throw new Error(
            `Cannot emit static route state for "${item.pathname}": the document request did ` +
              "not reach the route loader. Static client navigation has no server fallback.",
          );
        }

        if (isFallback && routeModule?.head) {
          console.warn(
            `  Warning: the head() export on dynamic SPA route "${item.fallbackFor}" is not ` +
              "applied. One document answers every matching URL, so build-time params would be " +
              "placeholders; use shared shell metadata or update document.head in the client.",
          );
        }

        assertSafePrerenderHeaders(response.headers, item);

        const html = await response.text();
        return {
          headers: Object.fromEntries(response.headers),
          html,
          item,
          markdown: typeof routeModule?.markdown === "string",
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
        render: result.item.render,
        ...(result.item.route.id ? { routeId: result.item.route.id } : {}),
        ...(result.item.fallbackFor !== undefined ? { fallbackFor: result.item.fallbackFor } : {}),
        ...(result.routeState !== undefined ? { routeState: result.routeState } : {}),
      });
      if (result.item.render === "isg" && result.item.revalidate) {
        isgManifest[result.item.pathname] = {
          generatedAt,
          revalidate: result.item.revalidate,
        };
      }
    }
  }

  if (options.withISGManifest) {
    const notFound = options.includeNotFound ? await prerenderNotFoundPage(options) : undefined;
    return { pages: results, isgManifest, ...(notFound ? { notFound } : {}) };
  }

  return results;
}

interface PrerenderWorkItem {
  pathname: string;
  render: "ssg" | "isg" | "spa";
  revalidate?: RouteRevalidate;
  route: ResolvedRoute;
  fallbackFor?: string;
}

/**
 * Path a dynamic SPA route's fallback document is rendered at. Every dynamic
 * segment collapses to the same placeholder: the document is client-rendered
 * and the real params come from `window.location` at boot, so this value only
 * ever reaches a `head()` export.
 */
const SPA_FALLBACK_PARAM = "_";

function hasDynamicSegments(route: ResolvedRoute): boolean {
  return route.segments.some((segment) => segment.type === "param" || segment.type === "catchall");
}

function buildSpaFallbackPath(route: ResolvedRoute): string {
  const params: RouteParams = {};
  for (const segment of route.segments) {
    if (segment.type === "param" || segment.type === "catchall") {
      params[segment.name] = SPA_FALLBACK_PARAM;
    }
  }
  return buildPathFromSegments(route.segments, params);
}

/**
 * Render the app's `notFound` page as a standalone document. Static hosts
 * serve one file for every unmatched URL, so it is rendered at a path that
 * matches no route and marked as a fallback document.
 */
async function prerenderNotFoundPage(
  options: PrerenderAppOptions,
): Promise<PrerenderResult | undefined> {
  const resolved = resolveApp(options.app);
  if (!resolved.notFound) return undefined;

  const url = new URL(NOT_FOUND_PRERENDER_PATH, "http://localhost");
  const response = await handlePrachtRequest({
    app: options.app,
    request: new Request(url, { method: "GET" }),
    registry: options.registry,
    clientEntryUrl: options.clientEntryUrl,
    islandsEntryUrl: options.islandsEntryUrl,
    islandsBootstrapRequired: options.islandsBootstrapRequired,
    cssManifest: options.cssManifest,
    jsManifest: options.jsManifest,
    fallbackDocument: true,
  });

  if (response.status !== 404) {
    // A catch-all route claimed the probe path, so the app has no unmatched
    // URLs for a 404 document to answer.
    console.warn(
      `  Warning: the notFound page was not reached (status ${response.status}); skipping 404 output.`,
    );
    return undefined;
  }

  assertSafePrerenderHeaders(response.headers, {
    pathname: NOT_FOUND_PRERENDER_PATH,
    render: "not-found",
  });

  return {
    path: NOT_FOUND_PRERENDER_PATH,
    html: await response.text(),
    headers: Object.fromEntries(response.headers),
    markdown: false,
    render: "not-found",
  };
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
  requireStaticPaths = false,
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
    if (requireStaticPaths) {
      throw new Error(
        `Cannot emit static route "${route.path}": dynamic SSG routes must export ` +
          "getStaticPaths() so every deployable URL is known at build time.",
      );
    }
    console.warn(
      `  Warning: SSG route "${route.path}" has dynamic segments but no getStaticPaths() export, skipping.`,
    );
    return [];
  }

  const paramSets = await routeModule.getStaticPaths();
  return paramSets.map((params) => buildPathFromSegments(route.segments, params));
}
