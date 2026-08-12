/**
 * Static-export target support shared by the client runtime and the server
 * renderer.
 *
 * `@pracht/adapter-static` builds ship no server, so the client cannot fetch
 * route-state JSON from the page URL (there is nothing to answer the
 * `x-pracht-route-state-request` header). Instead, `pracht build` serializes
 * every prerendered route's loader payload to a static JSON file under
 * `/_pracht/state/…`, and the client fetches that file during navigation.
 *
 * The switch is a compile-time define (`__PRACHT_STATIC_TARGET__`) injected by
 * `@pracht/vite-plugin` when the configured adapter declares
 * `staticTarget: true`. Every other adapter gets `false`, so the static
 * branches are dead-code-eliminated from their bundles. The `typeof` guard
 * keeps the module loadable in environments without the define (unit tests,
 * direct Node imports).
 */

declare const __PRACHT_STATIC_TARGET__: boolean | undefined;

export const IS_STATIC_TARGET: boolean =
  typeof __PRACHT_STATIC_TARGET__ !== "undefined" && __PRACHT_STATIC_TARGET__ === true;

/**
 * URL prefix of the serialized route-state tree. It lives inside `_pracht/`,
 * which the build already reserves for framework metadata
 * (`_pracht/headers.json`, `_pracht/markdown.json`), so state files can never
 * collide with a prerendered route: routes are written as
 * `<path>/index.html`, never under `_pracht/`.
 */
export const STATIC_STATE_PREFIX = "/_pracht/state";

/**
 * Map a request URL (path + optional query) to its static route-state file.
 *
 * The scheme mirrors the prerendered HTML layout — `/` →
 * `/_pracht/state/index.json`, `/blog/hello` →
 * `/_pracht/state/blog/hello/index.json` — using an `index.json` leaf so
 * `/blog` and `/blog/hello` never contend for the same path name.
 *
 * The query string is dropped deliberately: static loader data was produced
 * at build time from the bare pathname, so every query variant of a URL maps
 * to the same payload (exactly what the build generated). Percent-encoding is
 * preserved as-is because the build writes state files from the same encoded
 * route paths it writes HTML for — whatever host resolution works for the
 * page works for its state file.
 */
export function buildStaticRouteStateUrl(url: string): string {
  const queryIndex = url.indexOf("?");
  let pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const hashIndex = pathname.indexOf("#");
  if (hashIndex !== -1) pathname = pathname.slice(0, hashIndex);
  pathname = pathname.replace(/\/+$/, "");
  if (pathname === "") return `${STATIC_STATE_PREFIX}/index.json`;
  return `${STATIC_STATE_PREFIX}${pathname}/index.json`;
}
