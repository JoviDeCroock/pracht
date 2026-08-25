const CLIENT_MODULE_QUERY = "pracht-client";

export const PRACHT_CLIENT_MODULE_QUERY = `?${CLIENT_MODULE_QUERY}`;

export type RolldownLang = "js" | "jsx" | "ts" | "tsx";

export function isPrachtClientModuleId(id: string): boolean {
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return false;

  return id
    .slice(queryStart + 1)
    .split("&")
    .includes(CLIENT_MODULE_QUERY);
}

export function stripPrachtClientModuleQuery(id: string): string {
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return id;

  const path = id.slice(0, queryStart);
  const query = id
    .slice(queryStart + 1)
    .split("&")
    .filter((part) => part !== CLIENT_MODULE_QUERY);

  return query.length > 0 ? `${path}?${query.join("&")}` : path;
}

/** Extensions `@prefresh/vite` accepts: `/\.(c|m)?(t|j)sx?$/`, anchored at end. */
const PREFRESH_EXTENSION_RE = /\.((?:c|m)?[tj]sx?)$/i;

/**
 * The id to hand `@prefresh/vite` for a pracht client module.
 *
 * Prefresh uses the id for exactly three things: its `/\.(c|m)?(t|j)sx?$/`
 * filter, a `/\.tsx?$/` check that picks the TypeScript parser plugin, and the
 * key it embeds in the `$RefreshReg$` it injects. A query-carrying id fails the
 * first two, which is why route and shell modules got no Fast Refresh at all —
 * but simply stripping the query fails the third: one file under `src/routes`
 * can reach the browser as *two* module instances, once through the route glob
 * as `…/x.tsx?pracht-client` and once as a plain import from a sibling route.
 * Both would then register under the same key, and `@prefresh/core` treats a
 * second `register()` for a known key with a different function object as a
 * pending component replacement — which the next unrelated Fast Refresh
 * flushes, tearing down and re-running the untouched copy's effects.
 *
 * Moving the marker into the basename instead keeps the real extension last, so
 * the filter and the parser check still pass, while giving each copy its own
 * registration key: `/src/routes/x.tsx?pracht-client` becomes
 * `/src/routes/x.pracht-client.tsx`. The id is synthetic and never resolved
 * against the filesystem; the JSX dev transform has already stamped
 * `_jsxFileName` from the real id by the time prefresh runs, so dev source
 * locations and open-in-editor are unaffected.
 *
 * Ids whose extension prefresh would reject anyway (`.md`, `.mdx`, a configured
 * additional format) are returned query-stripped and left for prefresh to skip.
 */
export function toPrachtClientPrefreshId(id: string): string {
  const stripped = stripPrachtClientModuleQuery(id);
  const queryStart = stripped.indexOf("?");
  const path = queryStart === -1 ? stripped : stripped.slice(0, queryStart);
  const extension = PREFRESH_EXTENSION_RE.exec(path);
  if (!extension) return stripped;

  // Any query the module carried besides `pracht-client` still distinguishes
  // module instances, so it has to survive into the key. Characters that would
  // read as a new query or path segment are folded away — the value only has to
  // be stable and unique, never resolvable.
  const remainder =
    queryStart === -1 ? "" : stripped.slice(queryStart + 1).replace(/[^\w.-]/g, "_");
  const marker = remainder ? `${CLIENT_MODULE_QUERY}.${remainder}` : CLIENT_MODULE_QUERY;

  return `${path.slice(0, extension.index)}.${marker}.${extension[1]}`;
}

export function getRolldownLang(id: string): RolldownLang {
  const path = stripPrachtClientModuleQuery(id).split("?")[0];
  if (/\.(c|m)?tsx$/i.test(path)) return "tsx";
  if (/\.(c|m)?ts$/i.test(path)) return "ts";
  if (/\.(c|m)?jsx$/i.test(path)) return "jsx";
  if (/\.mdx?$/i.test(path)) return "jsx";
  if (/\.(c|m)?js$/i.test(path)) return "js";
  // Additional route formats are transformed by their own Vite plugin before
  // Pracht's post transform. TSX is permissive enough for the resulting JS and
  // JSX-runtime calls.
  return "tsx";
}
