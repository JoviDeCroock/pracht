import { h } from "preact";
import type { VNode } from "preact";

import { isServerOnly, isServerOnlyPlaceholder, type ServerOnly } from "./server-only.ts";

/**
 * A server-rendered subtree that is never hydrated.
 *
 * The markup is written by the server render and then adopted as-is: Preact
 * does not diff inside a `dangerouslySetInnerHTML` element, and during
 * hydration it does not write one either, so passing no markup on the client
 * leaves exactly what the document already contains. That is what makes
 * `serverOnly()` usable — the browser can render this boundary correctly
 * without ever receiving the HTML that produced it.
 *
 * ```tsx
 * export function loader() {
 *   return { html: serverOnly(renderArticle(source)) };
 * }
 *
 * export function Component({ data }: { data: RouteData }) {
 *   return <StaticHtml html={data.html} class="prose" />;
 * }
 * ```
 *
 * On a client-side navigation the route-state response carries the real
 * markup, so the same component renders the page the router moved to.
 *
 * The content is injected as raw HTML. Treat it exactly like
 * `dangerouslySetInnerHTML`: it must come from a source the app trusts —
 * repo-authored content, or output that was sanitized on the server.
 *
 * Nothing inside is interactive. Event handlers, hooks, and islands do not
 * exist in a subtree that never hydrates; put those next to the boundary
 * rather than in it.
 */
export interface StaticHtmlProps {
  /**
   * The markup to adopt. Accepts a plain string, or the `ServerOnly<string>`
   * returned by `serverOnly()` — including the placeholder the browser holds
   * for it during hydration.
   */
  html: string | ServerOnly<string>;
  /** Element to render. Must be an intrinsic tag name; defaults to `"div"`. */
  as?: string;
  /** Forwarded to the element verbatim — `class`, `id`, `style`, `data-*`. */
  [attribute: string]: unknown;
}

// `h` overloads a dynamic tag name onto an intrinsic-element props type,
// which a forwarded-attributes bag does not satisfy. The element is built by
// hand rather than through JSX for exactly that reason: `as` is a variable.
const createElement = h as (type: string, props: Record<string, unknown>) => VNode;

export function StaticHtml(props: StaticHtmlProps): VNode {
  const { html, as: tag = "div", ...attributes } = props;
  if (typeof tag !== "string") {
    throw new TypeError(
      `<StaticHtml as> must be an intrinsic tag name such as "div" or "article", not a ` +
        "component: the markup is adopted from the document, and only a real element can " +
        "carry it.",
    );
  }
  return createElement(tag, {
    ...attributes,
    dangerouslySetInnerHTML: { __html: resolveHtml(html) },
  });
}

function resolveHtml(html: StaticHtmlProps["html"]): string {
  if (typeof html === "string") return html;
  // The browser's copy of a stripped serverOnly() field. Rendering no markup
  // is what hands the subtree back to the DOM the server already wrote — and
  // re-renders keep passing this same empty string, which Preact skips.
  if (isServerOnlyPlaceholder(html)) return "";
  if (isServerOnly(html)) {
    const value = (html as unknown as { value: unknown }).value;
    if (typeof value !== "string") throw invalidHtml(value);
    return value;
  }
  throw invalidHtml(html);
}

function invalidHtml(value: unknown): TypeError {
  return new TypeError(
    `<StaticHtml html> expects a string or serverOnly(string), received ${describe(value)}. ` +
      "A loader that returns nothing for this field renders an empty boundary, which is " +
      "indistinguishable from adopted markup — so it is rejected instead.",
  );
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
