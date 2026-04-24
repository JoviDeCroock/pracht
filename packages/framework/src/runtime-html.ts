import { HYDRATION_STATE_ELEMENT_ID } from "./runtime-constants.ts";
import { applyHeaders, applySecurityAndRouteHeaders } from "./runtime-headers.ts";
import type { PrachtHydrationState } from "./runtime-hooks.ts";
import type { HeadMetadata } from "./types.ts";

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function serializeJsonForHtml(value: unknown): string {
  return escapeScriptText(JSON.stringify(value) ?? "null");
}

export function escapeScriptText(value: string): string {
  return value
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const SAFE_ATTRIBUTE_NAME_RE = /^[A-Za-z_:][A-Za-z0-9:._-]*$/;
const GLOBAL_HEAD_ATTRIBUTE_PREFIXES = ["data-", "aria-"];
const META_ATTRIBUTES = new Set([
  "charset",
  "content",
  "http-equiv",
  "itemprop",
  "media",
  "name",
  "property",
]);
const LINK_ATTRIBUTES = new Set([
  "as",
  "blocking",
  "color",
  "crossorigin",
  "disabled",
  "fetchpriority",
  "href",
  "hreflang",
  "imagesizes",
  "imagesrcset",
  "integrity",
  "media",
  "referrerpolicy",
  "rel",
  "sizes",
  "title",
  "type",
]);
const SCRIPT_ATTRIBUTES = new Set([
  "async",
  "blocking",
  "class",
  "crossorigin",
  "defer",
  "fetchpriority",
  "id",
  "integrity",
  "nomodule",
  "nonce",
  "referrerpolicy",
  "src",
  "type",
]);

function renderAttributes(
  attributes: Record<string, string | undefined>,
  allowedAttributes: ReadonlySet<string>,
): string {
  return Object.entries(attributes)
    .filter(([key, value]) => isAllowedHeadAttribute(key, value, allowedAttributes))
    .map(([key, value]) => `${key}="${escapeHtml(value ?? "")}"`)
    .join(" ");
}

function isAllowedHeadAttribute(
  key: string,
  value: string | undefined,
  allowedAttributes: ReadonlySet<string>,
): boolean {
  if (key === "children" || typeof value === "undefined" || !SAFE_ATTRIBUTE_NAME_RE.test(key)) {
    return false;
  }
  const normalized = key.toLowerCase();
  if (normalized.startsWith("on")) return false;
  return (
    allowedAttributes.has(normalized) ||
    GLOBAL_HEAD_ATTRIBUTE_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

export function buildHtmlDocument(options: {
  head: HeadMetadata;
  body: string;
  hydrationState: PrachtHydrationState;
  clientEntryUrl?: string;
  cssUrls?: string[];
  modulePreloadUrls?: string[];
  routeStatePreloadUrl?: string;
}): string {
  const {
    head,
    body,
    hydrationState,
    clientEntryUrl,
    cssUrls = [],
    modulePreloadUrls = [],
    routeStatePreloadUrl,
  } = options;

  const titleTag = head.title ? `<title>${escapeHtml(head.title)}</title>` : "";

  const metaTags = (head.meta ?? [])
    .map((m) => renderAttributes(m, META_ATTRIBUTES))
    .filter(Boolean)
    .map((attrs) => `<meta ${attrs}>`)
    .join("\n    ");

  const linkTags = (head.link ?? [])
    .map((l) => renderAttributes(l, LINK_ATTRIBUTES))
    .filter(Boolean)
    .map((attrs) => `<link ${attrs}>`)
    .join("\n    ");

  const scriptTags = (head.script ?? [])
    .map((script) => {
      const attrs = renderAttributes(script, SCRIPT_ATTRIBUTES);
      const children = script.children ? escapeScriptText(script.children) : "";
      return attrs ? `<script ${attrs}>${children}</script>` : `<script>${children}</script>`;
    })
    .join("\n    ");

  const cssTags = cssUrls
    .map((url) => `<link rel="stylesheet" href="${escapeHtml(url)}">`)
    .join("\n    ");

  const modulePreloadTags = modulePreloadUrls
    .map((url) => `<link rel="modulepreload" href="${escapeHtml(url)}">`)
    .join("\n    ");

  const routeStatePreloadTag = routeStatePreloadUrl
    ? `<link rel="preload" as="fetch" href="${escapeHtml(routeStatePreloadUrl)}" crossorigin="anonymous">`
    : "";

  const stateScript = `<script id="${HYDRATION_STATE_ELEMENT_ID}" type="application/json">${serializeJsonForHtml(hydrationState)}</script>`;
  const entryScript = clientEntryUrl
    ? `<script type="module" src="${escapeHtml(clientEntryUrl)}"></script>`
    : "";

  return `<!DOCTYPE html>
<html${head.lang ? ` lang="${escapeHtml(head.lang)}"` : ""}>
  <head>
    <meta charset="utf-8">
    ${titleTag}
    ${metaTags}
    ${linkTags}
    ${scriptTags}
    ${cssTags}
    ${modulePreloadTags}
    ${routeStatePreloadTag}
  </head>
  <body>
    <div id="pracht-root">${body}</div>
    ${stateScript}
    ${entryScript}
  </body>
</html>`;
}

export function htmlResponse(html: string, status = 200, initHeaders?: HeadersInit): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  if (initHeaders) {
    applyHeaders(headers, initHeaders);
  }
  applySecurityAndRouteHeaders(headers, { isRouteStateRequest: false });
  return new Response(html, { status, headers });
}
