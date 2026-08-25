import { collectFontHeadFragments } from "./font.ts";
import { HYDRATION_STATE_ELEMENT_ID } from "./runtime-constants.ts";
import { applyHeaders, applySecurityAndRouteHeaders } from "./runtime-headers.ts";
import type { PrachtHydrationState } from "./runtime-hooks.ts";
import type { SpeculationRulesDocument } from "./runtime-speculation.ts";
import { escapeScriptChildren } from "./script-escape.ts";
import type { HeadMetadata } from "./types.ts";

export { escapeScriptChildren };

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

export interface HtmlDocumentOptions {
  head: HeadMetadata;
  body: string;
  /**
   * Omitted for islands-mode and hydration-none routes: no state script and
   * no entry script are injected unless `clientEntryUrl` is set explicitly
   * (islands routes pass the islands bootstrap URL here).
   */
  hydrationState?: PrachtHydrationState;
  clientEntryUrl?: string;
  /** Let the streamed client runtime execute as soon as it is fetched. */
  clientEntryAsync?: boolean;
  /** Internal inline bootstrap emitted after state and before the client entry. */
  inlineBootstrapScript?: { source: string; nonce?: string };
  cssUrls?: string[];
  modulePreloadUrls?: string[];
  routeStatePreloadUrl?: string;
  speculationRules?: SpeculationRulesDocument | null;
}

/**
 * Assemble the document as three pieces so the streaming renderer can write
 * them around a body it does not have yet.
 *
 * `buildHtmlDocument()` is the concatenation of all three with the body in the
 * middle, so the buffered and streamed paths cannot drift apart.
 *
 * - `prefix` — through the opening `<div id="pracht-root">`
 * - `afterShell` — closes that div and carries the state and entry scripts, so
 *   the client can begin hydrating before deferred subtrees arrive
 * - `suffix` — `</body></html>`, written once the render is done
 */
export function buildHtmlDocumentParts(options: HtmlDocumentOptions): {
  prefix: string;
  afterShell: string;
  suffix: string;
} {
  const {
    head,
    hydrationState,
    clientEntryUrl,
    clientEntryAsync = false,
    inlineBootstrapScript,
    cssUrls = [],
    modulePreloadUrls = [],
    routeStatePreloadUrl,
    speculationRules,
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

  // Fonts registered via `defineFont()` expand into preload links plus one
  // inline style element. Dedupe (same font from shell and route) happens in
  // collectFontHeadFragments; the CSS it returns is already fully escaped and
  // can never contain an unescaped `<`, so it is safe inside <style>.
  const fontFragments = head.fonts?.length ? collectFontHeadFragments(head.fonts) : undefined;
  const fontLinkTags = fontFragments
    ? fontFragments.preloadLinks
        .map((link) => renderAttributes(link, LINK_ATTRIBUTES))
        .filter(Boolean)
        .map((attrs) => `<link data-pracht-font-preload ${attrs}>`)
        .join("\n    ")
    : "";
  const fontStyleTag =
    fontFragments?.css || head.fontNonce
      ? `<style data-pracht-fonts${head.fontNonce ? ` nonce="${escapeHtml(head.fontNonce)}"` : ""}>${fontFragments?.css ?? ""}</style>`
      : "";

  const scriptTags = (head.script ?? [])
    .map((script) => {
      const attrs = renderAttributes(script, SCRIPT_ATTRIBUTES);
      const children = script.children ? escapeScriptChildren(script.children, script.type) : "";
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

  const speculationRulesTag = speculationRules
    ? `<script type="speculationrules">${serializeJsonForHtml(speculationRules)}</script>`
    : "";

  const stateScript = hydrationState
    ? `<script id="${HYDRATION_STATE_ELEMENT_ID}" type="application/json">${serializeJsonForHtml(hydrationState)}</script>`
    : "";
  const bootstrapScript = inlineBootstrapScript
    ? `<script${inlineBootstrapScript.nonce ? ` nonce="${escapeHtml(inlineBootstrapScript.nonce)}"` : ""}>${escapeScriptChildren(inlineBootstrapScript.source)}</script>`
    : "";
  const entryScript = clientEntryUrl
    ? `<script type="module"${clientEntryAsync ? " async" : ""} src="${escapeHtml(clientEntryUrl)}"></script>`
    : "";

  // Empty slots are dropped rather than interpolated: otherwise every document
  // carries a run of blank, whitespace-only lines for the tags this page does
  // not have.
  const headLines = joinDocumentLines(
    [
      '<meta charset="utf-8">',
      titleTag,
      metaTags,
      linkTags,
      fontLinkTags,
      fontStyleTag,
      scriptTags,
      cssTags,
      modulePreloadTags,
      routeStatePreloadTag,
      speculationRulesTag,
    ],
    "    ",
  );
  const trailingScripts = joinDocumentLines([stateScript, bootstrapScript, entryScript], "    ");

  return {
    prefix: `<!DOCTYPE html>
<html${head.lang ? ` lang="${escapeHtml(head.lang)}"` : ""}>
  <head>
${headLines}
  </head>
  <body>
    <div id="pracht-root">`,
    afterShell: `</div>${trailingScripts ? `\n${trailingScripts}` : ""}`,
    suffix: `
  </body>
</html>`,
  };
}

export function buildHtmlDocument(options: HtmlDocumentOptions): string {
  const { prefix, afterShell, suffix } = buildHtmlDocumentParts(options);
  return `${prefix}${options.body}${afterShell}${suffix}`;
}

function joinDocumentLines(parts: string[], indent: string): string {
  return parts
    .filter((part) => part !== "")
    .map((part) => `${indent}${part}`)
    .join("\n");
}

export function htmlResponse(html: string, status = 200, initHeaders?: HeadersInit): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  if (initHeaders) {
    applyHeaders(headers, initHeaders);
  }
  applySecurityAndRouteHeaders(headers, { isRouteStateRequest: false });
  return new Response(html, { status, headers });
}
