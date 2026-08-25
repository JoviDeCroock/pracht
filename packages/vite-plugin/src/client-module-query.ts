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

export function isPrefreshCompatibleId(id: string): boolean {
  return PREFRESH_EXTENSION_RE.test(id);
}

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
 * A reserved, length-prefixed namespace keeps the real extension last, so the
 * filter and parser check still pass, while giving each complete module id its
 * own registration key. Keeping the authored id verbatim makes the mapping
 * injective; keeping it behind a non-file prefix prevents a real sibling such
 * as `x.pracht-client.tsx` from colliding with the synthetic key. The id is
 * never resolved against the filesystem; the JSX dev transform has already
 * stamped `_jsxFileName` from the real id by the time prefresh runs, so dev
 * source locations and open-in-editor are unaffected.
 *
 * Compiled formats whose real extension prefresh rejects (`.md`, `.mdx`, and
 * configured additional formats) instead keep that extension in the basename
 * and receive a synthetic `.jsx`. Their companion Vite plugin has already
 * turned the authored format into JavaScript by the time this id is used.
 */
export function toPrachtClientPrefreshId(id: string): string {
  const stripped = stripPrachtClientModuleQuery(id);
  const queryStart = stripped.indexOf("?");
  const path = queryStart === -1 ? stripped : stripped.slice(0, queryStart);
  const extension = PREFRESH_EXTENSION_RE.exec(path);
  const parserExtension = extension?.[1] ?? "jsx";

  // Prefresh embeds this whole value in its component registration key. A
  // length prefix makes the namespace unambiguous, and retaining the complete
  // id distinguishes every remaining query without lossy character folding.
  return `pracht-client:${id.length}:${id}.${parserExtension}`;
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
