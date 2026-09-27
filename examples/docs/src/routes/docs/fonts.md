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

The server expands each font into head HTML, so routes with `hydration: "none"` get the same output:

```html
<link data-pracht-font-preload rel="preload" as="font" type="font/woff2" href="/fonts/inter-latin.woff2" crossorigin="anonymous">
<style data-pracht-fonts>
@font-face{font-family:"Inter";src:url("/fonts/inter-latin.woff2") format("woff2");font-weight:100 900;font-display:swap}
.pracht-font-inter-xxxx{font-family:"Inter", "Arial", sans-serif}
</style>
```

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

Importing a font or using its `className` does not register it: list the font
in the active shell or route `head().fonts`. Client navigation updates the font
CSS and preload links to match the new route.

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

`src` accepts multiple variants of the same face. `woff2` is assumed unless a
`format` is given. Pracht lists WOFF2 variants first and preloads one source:
the first WOFF2, or the first variant when there is none.

```ts
defineFont({
  family: "Custom",
  src: [
    { url: "/fonts/custom.woff2" },
    { url: "/fonts/custom.woff", format: "woff" },
  ],
});
```

One `defineFont()` call describes one face. For a static font with several weights, define one font per weight file:

```ts
export const interRegular = defineFont({ family: "Inter", src: "/fonts/inter-400.woff2", weight: 400 });
export const interBold = defineFont({ family: "Inter", src: "/fonts/inter-700.woff2", weight: 700 });
// head: { fonts: [interRegular, interBold] }
```

## Deduplication

A font registered by both a shell and a route emits one preload link and one `@font-face` block. Unicode-range subsets of one family still keep a face each.

Register site-wide fonts in the shell's `head()` and page-specific fonts in the route's `head()`; overlap is free.

## Fallback Metrics (no layout shift)

With `font-display: swap`, text renders in a fallback font first and swaps when the web font loads. If the metrics differ, the page shifts. The metric overrides generate a fallback face that reshapes a local font to match:

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

The extra face needs a real font for `local()`, so it uses the first `fallbacks` entry that is not a generic family (`sans-serif`, `system-ui`, ...) or vendor keyword (`-apple-system`). To pick a different one, point `metricsFallback` at the font the numbers were computed against:

```ts
fallbacks: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Arial", "sans-serif"],
metricsFallback: "Arial",
```

The generated face:

```css
@font-face {
  font-family: "Inter Fallback 1a2b3c";
  src: local("Arial");
  font-weight: 400;
  size-adjust: 107.64%;
  ascent-override: 90.44%;
  descent-override: 22.52%;
  line-gap-override: 0%;
}
```

and the stack becomes `"Inter", "Inter Fallback 1a2b3c", "Arial", sans-serif`.

**Computing the values:** the overrides are ratios of the web font's metrics (`ascent`, `descent`, `lineGap`, per-glyph advance widths) to the fallback font's, expressed as percentages. You can:

- copy them from [Fontaine](https://github.com/nuxt-modules/fontaine) or the [fallback metrics tables](https://github.com/seek-oss/capsize/blob/master/packages/metrics/README.md) published by Capsize (`@capsizecss/metrics` has data for common families),
- or compute them once with `npx fontpie ./public/fonts/inter-latin.woff2 --fallback arial`.

Pracht does not read font files, so you supply these values yourself.

## Security Notes

Family names and URLs are escaped in the generated CSS. Invalid descriptor values, such as a malformed `weight`, `unicodeRange`, or metric override, throw when `defineFont()` runs.

For a nonce-based Content Security Policy, return the request's nonce as
`styleNonce` from a shared shell `head()` and include it in `style-src`:

```ts
export function head({ context }) {
  return { fonts: [inter], styleNonce: context.cspNonce };
}
```

`fontNonce` also works but covers only font styles. Prefer `styleNonce`, which
also covers `pracht({ inlineCss: true })`.

Under a strict policy, use `font.className` rather than `font.style`: inline
style attributes need a separate CSP allowance. SSG and ISG pages cannot reuse a
request nonce, so use a style hash or an external stylesheet policy there.
