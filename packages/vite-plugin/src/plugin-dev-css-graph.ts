import type { ModuleRegistry, ResolvedPrachtApp, ResolvedRoute } from "@pracht/core";
import type { EnvironmentModuleNode, ViteDevServer } from "vite";

const CSS_MODULE_URL_RE = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;

/**
 * Build the development equivalent of the production CSS manifest for the
 * current route. Vite turns CSS imports into client-side style injection by
 * default; resolving the same imports through the active server environment
 * graphs lets pracht put real stylesheet links in the initial document and
 * avoid a first-paint FOUC.
 */
export async function createDevCssManifest(
  server: ViteDevServer,
  options: {
    app: ResolvedPrachtApp;
    matchAppRoute: (
      app: ResolvedPrachtApp,
      pathname: string,
    ) => { route: ResolvedRoute } | undefined;
    pathname: string;
    registry: ModuleRegistry;
  },
): Promise<Record<string, string[]>> {
  const route = options.matchAppRoute(options.app, options.pathname)?.route ?? options.app.notFound;
  if (!route) return {};

  const manifest: Record<string, string[]> = {};
  const modules = [
    ...(route.shellFile
      ? [{ file: route.shellFile, registry: options.registry.shellModules }]
      : []),
    { file: route.file, registry: options.registry.routeModules },
  ];

  const results = await Promise.all(
    modules.map(async ({ file, registry }) => {
      if (!registry) return { file, urls: [] };
      const moduleKey = findRegistryModuleKey(registry, file);
      if (!moduleKey) return { file, urls: [] };

      // Adapters can name their server environment (for example, Cloudflare
      // does), so inspect every graph instead of assuming `ssr`.
      const entries = await Promise.all(
        Object.values(server.environments).map((environment) =>
          environment.moduleGraph.getModuleByUrl(moduleKey),
        ),
      );
      const urls = [...new Set(entries.flatMap((entry) => collectDevCssUrls(entry)))];
      return { file, urls };
    }),
  );

  for (const { file, urls } of results) {
    if (urls.length > 0) manifest[file] = urls;
  }

  return manifest;
}

export function collectDevCssUrls(entry: EnvironmentModuleNode | undefined): string[] {
  if (!entry) return [];

  const urls = new Set<string>();
  const visited = new Set<EnvironmentModuleNode>();
  const pending = [entry];

  while (pending.length > 0) {
    const module = pending.pop()!;
    if (visited.has(module)) continue;
    visited.add(module);

    // SSR transforms CSS imports into JavaScript modules, so Vite can label
    // these nodes as `js`. The URL remains the reliable signal for CSS and
    // preprocessor requests; asset/string queries are intentionally excluded.
    if (
      (module.type === "css" || CSS_MODULE_URL_RE.test(module.url)) &&
      !/[?&](?:inline|raw|url)(?:[=&]|$)/.test(module.url)
    ) {
      urls.add(module.url);
    }
    pending.push(...[...module.importedModules].reverse());
  }

  return [...urls];
}

function findRegistryModuleKey(
  modules: Record<string, () => Promise<unknown>> | undefined,
  file: string,
): string | undefined {
  if (!modules) return undefined;
  if (file in modules) return file;

  const suffix = `/${file
    .split("?")[0]
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")}`;
  return Object.keys(modules).find((key) => key.split("?")[0].replace(/\\/g, "/").endsWith(suffix));
}
