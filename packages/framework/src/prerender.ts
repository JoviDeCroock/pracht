import { resolveApp } from "./app.ts";
import { buildPathFromSegments } from "./route-matching.ts";
import { isDangerousPrerenderHeader, normalizeRouteRevalidate } from "./revalidation.ts";
import { hasMarkdownRepresentation } from "./runtime-negotiation.ts";
import { NOT_FOUND_ROUTE_ID, ROUTE_STATE_REQUEST_HEADER } from "./runtime-constants.ts";
import { routeNeedsServerFetch } from "./runtime-client-fetch.ts";
import type { SerializedRouteError } from "./runtime-errors.ts";
import { buildHtmlDocument } from "./runtime-html.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import { handlePrachtRequest } from "./runtime.ts";
import type {
  HeadMetadata,
  ModuleRegistry,
  PrachtApp,
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
   * for `staticExport` builds, and only for loader-backed SSG routes whose
   * client navigation needs the build-time payload.
   */
  routeState?: string;
  /** Whether this page is a `render: "spa"` shell (staticExport builds only). */
  spa?: boolean;
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
  /** Per-source-file CSS map produced by the vite plugin. */
  cssManifest?: Record<string, string[]>;
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
  const work: {
    pathname: string;
    render: string;
    revalidate?: RouteRevalidate;
    route: ResolvedRoute;
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
                "A static build cannot preserve request-time redirects or failures; make the loader succeed at build time or use a serverful adapter.",
            );
          }
          console.warn(
            `  Warning: ${item.render.toUpperCase()} route "${item.pathname}" returned status ${response.status}, skipping.`,
          );
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

        const html = await response.text();

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
          routeNeedsServerFetch(item.route)
        ) {
          const stateResponse = await handlePrachtRequest({
            app: options.app,
            request: new Request(url, {
              method: "GET",
              headers: { [ROUTE_STATE_REQUEST_HEADER]: "1" },
            }),
            registry: options.registry,
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
                  "Make the loader succeed at build time or use a serverful adapter.",
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

  if (options.withISGManifest) {
    return { pages: results, isgManifest };
  }

  return results;
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
