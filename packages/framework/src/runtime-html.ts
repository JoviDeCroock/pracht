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
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
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
    .map(
      (m) =>
        `<meta ${Object.entries(m)
          .map(([k, v]) => `${k}="${escapeHtml(v)}"`)
          .join(" ")}>`,
    )
    .join("\n    ");

  const linkTags = (head.link ?? [])
    .map(
      (l) =>
        `<link ${Object.entries(l)
          .map(([k, v]) => `${k}="${escapeHtml(v)}"`)
          .join(" ")}>`,
    )
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
