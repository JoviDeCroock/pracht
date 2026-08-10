import { resolveApp } from "./app.ts";
import { buildPathFromSegments } from "./route-matching.ts";
import { isDangerousPrerenderHeader, normalizeRouteRevalidate } from "./revalidation.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import { handlePrachtRequest } from "./runtime.ts";
import type {
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
  /** Whether the route module exports a raw Markdown representation. */
  markdown: boolean;
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
  /** Per-source-file CSS map produced by the vite plugin. */
  cssManifest?: Record<string, string[]>;
  /** Per-source-file JS map produced by the vite plugin for modulepreload hints. */
  jsManifest?: Record<string, string[]>;
  /** Maximum number of pages rendered concurrently. Defaults to 10. */
  concurrency?: number;
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
    if (route.render !== "ssg" && route.render !== "isg") continue;
    const paths = await collectSSGPaths(route, options.registry);
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

        const [response, routeModule] = await Promise.all([
          handlePrachtRequest({
            app: options.app,
            request,
            registry: options.registry,
            clientEntryUrl: options.clientEntryUrl,
            cssManifest: options.cssManifest,
            jsManifest: options.jsManifest,
          }),
          resolveRegistryModule<RouteModule>(options.registry?.routeModules, item.route.file),
        ]);

        if (response.status !== 200) {
          console.warn(
            `  Warning: ${item.render.toUpperCase()} route "${item.pathname}" returned status ${response.status}, skipping.`,
          );
          return null;
        }

        assertSafePrerenderHeaders(response.headers, item);

        const html = await response.text();
        return {
          headers: Object.fromEntries(response.headers),
          html,
          item,
          markdown: typeof routeModule?.markdown === "string",
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

async function collectSSGPaths(route: ResolvedRoute, registry?: ModuleRegistry): Promise<string[]> {
  const hasDynamicSegments = route.segments.some(
    (s) => s.type === "param" || s.type === "catchall",
  );

  if (!hasDynamicSegments) {
    return [route.path];
  }

  // Dynamic route — must export getStaticPaths() to enumerate params
  const routeModule = await resolveRegistryModule<RouteModule>(registry?.routeModules, route.file);

  if (!routeModule?.getStaticPaths) {
    console.warn(
      `  Warning: SSG route "${route.path}" has dynamic segments but no getStaticPaths() export, skipping.`,
    );
    return [];
  }

  const paramSets = await routeModule.getStaticPaths();
  return paramSets.map((params) => buildPathFromSegments(route.segments, params));
}
