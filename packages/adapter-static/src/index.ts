import type { PrachtAdapter } from "@pracht/vite-plugin";

/**
 * Deployment shape `pracht build` emits alongside `dist/client`.
 *
 * - `netlify` — `_headers` and `_redirects` files, read by Netlify (and by
 *   Cloudflare Pages, which implements the same two formats).
 * - `vercel` — a functionless Build Output API v3 directory
 *   (`.vercel/output`), deployable with `vercel deploy --prebuilt`.
 * - `generic` — no host configuration. `dist/client` is the whole
 *   deployment; the build prints the routing and header rules the host has to
 *   be told about by hand.
 */
export type StaticHost = "netlify" | "vercel" | "generic";

export interface StaticAdapterOptions {
  /** Host configuration to emit. Defaults to `"generic"`. */
  host?: StaticHost;
}

const STATIC_HOSTS: readonly StaticHost[] = ["netlify", "vercel", "generic"];

export function createStaticServerEntryModule(options: StaticAdapterOptions = {}): string {
  const host = options.host ?? "generic";
  if (!STATIC_HOSTS.includes(host)) {
    throw new Error(
      `staticAdapter({ host }) expects one of ${STATIC_HOSTS.map((value) => JSON.stringify(value)).join(", ")}; received ${JSON.stringify(host)}.`,
    );
  }

  return [
    "// The static target has no request handler: every document is written to",
    "// dist/client at build time. This module exists so `pracht build` can load",
    "// the app graph and prerender it.",
    `export const staticHost = ${JSON.stringify(host)};`,
    "",
  ].join("\n");
}

/**
 * Create a pracht adapter that builds a deployment with no server runtime.
 *
 * Every route must be renderable ahead of time — `ssg`, or `spa` for pages
 * that fetch their own data in the browser — and the app cannot have API
 * routes. `pracht build` fails with the offending routes listed when it
 * cannot honour that, rather than emitting output that 404s in production.
 *
 * ```ts
 * import { staticAdapter } from "@pracht/adapter-static";
 * pracht({ adapter: staticAdapter({ host: "netlify" }) })
 * ```
 */
export function staticAdapter(options: StaticAdapterOptions = {}): PrachtAdapter {
  return {
    id: "static",
    // Client navigations read the route-state snapshots the build writes
    // next to each document; `pracht dev` serves the same URLs from the live
    // app so both halves of the app are exercised in development.
    staticRouteState: true,
    serverImports: 'import { resolveApp, resolveApiRoutes } from "@pracht/core/server";',
    createServerEntryModule() {
      return createStaticServerEntryModule(options);
    },
  };
}
