---
title: Fonts
lead: Self-host fonts with `defineFont()` — typed `@font-face` generation, automatic preload links, deduped head output, and layout-shift-free fallbacks. No files are fetched at build time.
breadcrumb: Fonts
prev:
  href: /docs/styling
  title: Styling
next:
  href: /docs/images
  title: Images
---

## Quick Start

Put the font file in `public/` and describe it once with `defineFont()`:

```ts [src/fonts.ts]
import { defineFont } from "@pracht/core";

export const inter = defineFont({
  family: "Inter",
  src: "/fonts/inter-latin.woff2",
  weight: "100 900", // variable font range
  fallbacks: ["Arial", "sans-serif"],
});
```

Register it in a shell (site-wide) or route `head()` via the `fonts` array, and use it in components:

```tsx [src/shells/public.tsx]
import { inter } from "../fonts";

export function head() {
  return { title: "My Site", fonts: [inter] };
}

export function Shell({ children }) {
  return <div style={inter.style}>{children}</div>;
}
```

The server expands each font into head HTML — routes with `hydration: "none"` get the exact same output, since no JavaScript is involved:

```html
<link data-pracht-font-preload rel="preload" as="font" type="font/woff2" href="/fonts/inter-latin.woff2" crossorigin="anonymous">
<style data-pracht-fonts>
@font-face{font-family:"Inter";src:url("/fonts/inter-latin.woff2") format("woff2");font-weight:100 900;font-display:swap}
.pracht-font-inter-xxxx{font-family:"Inter", "Arial", sans-serif}
</style>
```

Font preloads always carry `crossorigin="anonymous"` — fonts are fetched in CORS mode even from your own origin, and a preload without it would be fetched twice.

## Using the Font in Components

Every font object exposes three ways to apply it:

```tsx [src/routes/home.tsx]
import { inter } from "../fonts";

export default function Home() {
  return (
    <>
      {/* class name — the rule ships with the injected font CSS */}
      <h1 class={inter.className}>Hello</h1>
      {/* inline style object */}
      <p style={inter.style}>Body copy</p>
      {/* raw font stack for your own CSS variables */}
      <div style={{ "--font-sans": inter.fontFamily }} />
    </>
  );
}
```

`inter.fontFamily` is the full stack including fallbacks, e.g. `"Inter", "Arial", sans-serif`.
Importing a font or using its `className` does not register it by itself: list
the font in the active shell or route `head().fonts`. Pracht updates generated
font CSS and preload links when client navigation changes the active route.

## Options

```ts
defineFont({
  family: "Inter",           // required — @font-face family name
  src: "/fonts/inter.woff2", // required — public path, or an array of variants
  weight: "100 900",         // font-weight descriptor (number, string, or range)
  style: "italic",           // font-style descriptor
  display: "swap",           // font-display (default "swap")
  preload: true,             // emit <link rel="preload"> (default true)
  unicodeRange: "U+0000-00FF",
  fallbacks: ["Arial", "sans-serif"],
  // fallback metric overrides — see below
  metricsFallback: "Arial",
  sizeAdjust: "107%",
  ascentOverride: "90%",
  descentOverride: "22.5%",
  lineGapOverride: "0%",
});
```

`src` accepts multiple variants of the same face. `woff2` is assumed unless a `format` is given, and only `woff2` variants are preloaded (browsers pick one source; preloading the rest wastes bandwidth):

```ts
defineFont({
  family: "Custom",
  src: [
    { url: "/fonts/custom.woff2" },
    { url: "/fonts/custom.woff", format: "woff" },
  ],
});
```

One `defineFont()` call describes one face. For multiple weights of a static font, define one font per weight file — pracht dedupes the shared fallback and class rules automatically:

```ts
export const interRegular = defineFont({ family: "Inter", src: "/fonts/inter-400.woff2", weight: 400 });
export const interBold = defineFont({ family: "Inter", src: "/fonts/inter-700.woff2", weight: 700 });
// head: { fonts: [interRegular, interBold] }
```

## Deduplication

The same font registered by a shell and a route (or by several routes sharing a shell) emits exactly one preload link and one `@font-face` block. Preloads dedupe by `href`; `@font-face` blocks, fallback faces, and class rules dedupe by content, so unicode-range subsets of one family (same family, weight, and style — only `src` and `unicodeRange` differ) each keep their own face. Register site-wide fonts once in the shell's `head()` and page-specific fonts in the route's `head()` — overlap is free.

## Fallback Metrics (no layout shift)

With `font-display: swap`, text renders in a fallback font first and swaps when the web font loads. If the fallback has different metrics, the page shifts. The metric override options generate an adjusted fallback face that reshapes a local font to match your web font:

```ts
export const inter = defineFont({
  family: "Inter",
  src: "/fonts/inter-latin.woff2",
  fallbacks: ["Arial", "sans-serif"],
  sizeAdjust: "107.64%",
  ascentOverride: "90.44%",
  descentOverride: "22.52%",
  lineGapOverride: "0%",
});
```

This emits an extra face — `local()` requires a real installed font, so the first entry in `fallbacks` that is neither a generic family (`sans-serif`, `system-ui`, ...) nor a vendor keyword (`-apple-system`) is used. When your stack starts with names `local()` cannot match, point `metricsFallback` at the font the numbers were computed against:

```ts
fallbacks: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Arial", "sans-serif"],
metricsFallback: "Arial",
```

The generated face:

```css
@font-face {
  font-family: "Inter Fallback 1a2b3c";
  src: local("Arial");
  size-adjust: 107.64%;
  ascent-override: 90.44%;
  descent-override: 22.52%;
  line-gap-override: 0%;
}
```

and the stack becomes `"Inter", "Inter Fallback 1a2b3c", "Arial", sans-serif`. The name carries a short hash of the local font and metric values, so two faces of the same family with different per-weight metrics can never clobber each other — identical metrics still share one fallback face.

**Computing the values:** the overrides are ratios of the web font's metrics (`ascent`, `descent`, `lineGap`, per-glyph advance widths) to the fallback font's, expressed as percentages. You can:

- copy them from [Fontaine](https://github.com/nuxt-modules/fontaine) or the [fallback metrics tables](https://github.com/seek-oss/capsize/blob/master/packages/metrics/README.md) published by Capsize (`@capsizecss/metrics` has data for common families),
- or compute them once with `npx fontpie ./public/fonts/inter-latin.woff2 --fallback arial`.

Pracht deliberately does not read the font binary at build time, so these stay explicit inputs. Automatic metric extraction (and a Google Fonts downloader) are candidates for future work.

## Security Notes

Everything interpolated into the generated CSS is escaped or validated: family names and URLs are CSS-string-escaped (including `<`, so the inline `<style>` can never be closed early), and descriptor values like `weight`, `display`, `unicodeRange`, and the metric overrides are validated against strict grammars — invalid values throw at `defineFont()` time rather than reaching the document.

For a nonce-based Content Security Policy, return the request-specific nonce as
`fontNonce` from a shared shell `head()` and include the same nonce in
`style-src`. Pracht places it on the generated font style and preserves that
style element across client navigation:

```ts
export function head({ context }) {
  return { fonts: [inter], fontNonce: context.cspNonce };
}
```

Use `font.className` rather than `font.style` under a strict policy, because
inline style attributes need a separate CSP allowance. Static SSG/ISG output
cannot safely reuse a request nonce; use a stable style hash or an external
stylesheet policy for those routes.
