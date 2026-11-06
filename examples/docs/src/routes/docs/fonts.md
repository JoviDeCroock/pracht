---
title: Fonts
lead: "Self-host fonts with `defineFont()`: generated `@font-face` rules, preload links, and size-matched fallbacks that prevent layout shift."
---

## Quick start

Put a self-hosted WOFF2 file in `src/fonts/` and import its URL into `defineFont()`:

```ts [src/fonts.ts]
import { defineFont } from "@pracht/core";
import interUrl from "./fonts/inter-latin.woff2?url&no-inline";

export const inter = defineFont({
  family: "Inter",
  src: interUrl,
  weight: "100 900", // variable font range
  fallbacks: ["Arial", "sans-serif"],
});
```

Vite emits the font as a content-hashed asset and applies your deploy `base` to the URL. `?url&no-inline` keeps small subsets in a separate file, so the preload and `@font-face` use the same URL. Keep `vite/client` in your TypeScript types for asset imports.

Register the font in a shell (site-wide) or a route `head()` through the `fonts` array, then apply it in components:

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
<link data-pracht-font-preload rel="preload" as="font" type="font/woff2" href="/assets/inter-latin-HASH.woff2" crossorigin="anonymous">
<style data-pracht-fonts>
@font-face{font-family:"Inter";src:url("/assets/inter-latin-HASH.woff2") format("woff2");font-weight:100 900;font-display:swap}
.pracht-font-inter-xxxx{font-family:"Inter", "Arial", sans-serif}
</style>
```

`HASH` stands for the content hash Vite adds at build time, so a changed font gets a new URL. Configure your host to cache hashed assets with `Cache-Control: public, max-age=31536000, immutable`.

For a stable URL, put the file in `public/fonts/` and set `src: "/fonts/inter-latin.woff2"`. Public files keep their names, so serve them with revalidation rather than immutable caching if their bytes can change.

## Use the font in components

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

`inter.fontFamily` is the full stack including fallbacks, for example `"Inter", "Arial", sans-serif`.

Importing a font or using its `className` does not register it: list the font in the active shell or route `head().fonts`. Client navigation updates the font CSS and preload links to match the new route.

## Options

```ts
defineFont({
  family: "Inter",           // required — @font-face family name
  src: "/fonts/inter.woff2", // required — imported URL, public path, or variant array
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

An invalid descriptor, such as a malformed `weight`, `unicodeRange`, or metric override, throws when `defineFont()` runs.

`src` accepts several variants of the same face. `woff2` is assumed unless you set `format`. WOFF2 variants are listed first, and one source is preloaded: the first WOFF2, or the first variant when there is none.

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

Register site-wide fonts in the shell's `head()` and page-specific fonts in the route's `head()`. A font registered by both emits one preload link and one `@font-face` block. Unicode-range subsets of one family keep a face each.

## Fallback metrics (no layout shift)

With `font-display: swap`, text renders in a fallback font first and swaps when the web font loads. If the metrics differ, the page shifts. Set the metric overrides to generate a fallback face that reshapes a local font to match:

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

The generated face needs a real font for `local()`, so it uses the first `fallbacks` entry that is not a generic family (`sans-serif`, `system-ui`, ...) or vendor keyword (`-apple-system`). To choose another, point `metricsFallback` at the font the numbers were computed against:

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

The stack becomes `"Inter", "Inter Fallback 1a2b3c", "Arial", sans-serif`.

pracht does not read font files, so you supply the override values. They are ratios of the web font's metrics (`ascent`, `descent`, `lineGap`, advance widths) to the fallback font's, as percentages. Get them from:

- [Fontaine](https://github.com/nuxt-modules/fontaine) or the [Capsize fallback metrics](https://github.com/seek-oss/capsize/blob/master/packages/metrics/README.md) (`@capsizecss/metrics` covers common families).
- `npx fontpie ./public/fonts/inter-latin.woff2 --fallback arial`, run once.

## Content Security Policy

For a nonce-based policy, return the request's nonce as `styleNonce` from a shared shell `head()` and include it in `style-src`:

```ts
export function head({ context }) {
  return { fonts: [inter], styleNonce: context.cspNonce };
}
```

`styleNonce` also covers `pracht({ inlineCss: true })`. `fontNonce` covers only font styles.

Under a strict policy, use `font.className` rather than `font.style`, because inline style attributes need a separate CSP allowance. SSG and ISG pages cannot reuse a request nonce, so use a style hash or an external stylesheet policy there.
