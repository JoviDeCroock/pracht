import { describe, expect, it } from "vitest";

import { collectFontHeadFragments, defineFont, escapeCssString } from "../src/font.ts";
import { buildHtmlDocument } from "../src/runtime-html.ts";
import { mergeHeadMetadata } from "../src/runtime-middleware.ts";
import type { BaseRouteArgs, HeadMetadata } from "../src/types.ts";

const inter = defineFont({
  family: "Inter",
  src: "/fonts/inter-latin.woff2",
  weight: "100 900",
  fallbacks: ["Arial", "sans-serif"],
  sizeAdjust: "107%",
  ascentOverride: "90%",
  descentOverride: "22.5%",
  lineGapOverride: "0%",
});

// The fallback family name carries a metrics hash so that different metric
// overrides for the same family can never clobber each other's face.
const interFallbackName = /"Inter Fallback ([a-z0-9]+)"/.exec(inter.fontFamily)?.[1] ?? "";

describe("defineFont", () => {
  it("builds a font stack with the adjusted fallback face between font and fallbacks", () => {
    expect(inter.fontFamily).toBe(
      `"Inter", "Inter Fallback ${interFallbackName}", "Arial", sans-serif`,
    );
    expect(inter.fontFamily).toMatch(/^"Inter", "Inter Fallback [a-z0-9]+", "Arial", sans-serif$/);
    expect(inter.style).toEqual({ fontFamily: inter.fontFamily });
    expect(inter.className).toMatch(/^pracht-font-inter-[a-z0-9]+$/);
  });

  it("generates the @font-face rule with defaulted woff2 format and swap display", () => {
    expect(inter.faceCss).toBe(
      '@font-face{font-family:"Inter";src:url("/fonts/inter-latin.woff2") format("woff2");font-weight:100 900;font-display:swap}',
    );
  });

  it("generates an adjusted local fallback face from the first non-generic fallback", () => {
    expect(inter.fallbackFaceCss).toBe(
      `@font-face{font-family:"Inter Fallback ${interFallbackName}";src:local("Arial");size-adjust:107%;ascent-override:90%;descent-override:22.5%;line-gap-override:0%}`,
    );
  });

  it("keeps fallback faces with different metrics for the same family distinct", () => {
    // Per-weight metrics (e.g. fontpie output per file) legitimately differ;
    // with a shared "<family> Fallback" name the last face would clobber the
    // other's metrics for every user of the stack.
    const regular = defineFont({
      family: "Inter",
      src: "/fonts/inter-400.woff2",
      weight: 400,
      fallbacks: ["Arial"],
      sizeAdjust: "107%",
    });
    const bold = defineFont({
      family: "Inter",
      src: "/fonts/inter-700.woff2",
      weight: 700,
      fallbacks: ["Arial"],
      sizeAdjust: "112%",
    });
    expect(regular.fontFamily).not.toBe(bold.fontFamily);
    const nameOf = (font: typeof regular) =>
      /"(Inter Fallback [a-z0-9]+)"/.exec(font.fallbackFaceCss ?? "")?.[1];
    expect(nameOf(regular)).toBeDefined();
    expect(nameOf(regular)).not.toBe(nameOf(bold));
    // Each stack references its own fallback face.
    expect(regular.fontFamily).toContain(`"${nameOf(regular)}"`);
    expect(bold.fontFamily).toContain(`"${nameOf(bold)}"`);
    const fragments = collectFontHeadFragments([regular, bold]);
    expect(fragments.css).toContain("size-adjust:107%");
    expect(fragments.css).toContain("size-adjust:112%");
  });

  it("trims metricsFallback before it reaches local()", () => {
    const font = defineFont({
      family: "X",
      src: "/f.woff2",
      metricsFallback: " Arial ",
      sizeAdjust: "107%",
    });
    expect(font.fallbackFaceCss).toContain('src:local("Arial")');
  });

  it("skips the fallback face when every fallback is a generic family", () => {
    const font = defineFont({
      family: "Inter",
      src: "/fonts/inter.woff2",
      fallbacks: ["sans-serif"],
      sizeAdjust: "107%",
    });
    expect(font.fallbackFaceCss).toBeUndefined();
    expect(font.fontFamily).toBe('"Inter", sans-serif');
  });

  it("uses metricsFallback for the local() source when the stack starts with unmatchable names", () => {
    const font = defineFont({
      family: "Inter",
      src: "/fonts/inter.woff2",
      fallbacks: ["-apple-system", "BlinkMacSystemFont", "Arial", "sans-serif"],
      metricsFallback: "Arial",
      sizeAdjust: "107%",
    });
    expect(font.fallbackFaceCss).toContain('src:local("Arial")');
    // Vendor keywords cannot be matched by local(), so the heuristic skips
    // them and picks the first real family name.
    const heuristic = defineFont({
      family: "Inter",
      src: "/fonts/inter.woff2",
      fallbacks: ["-apple-system", "Arial"],
      sizeAdjust: "107%",
    });
    expect(heuristic.fallbackFaceCss).toContain('src:local("Arial")');
  });

  it("rejects generic and vendor keywords as an explicit metrics fallback", () => {
    for (const metricsFallback of ["sans-serif", "Sans-Serif", "-apple-system"]) {
      expect(() =>
        defineFont({
          family: "Inter",
          src: "/fonts/inter.woff2",
          metricsFallback,
          sizeAdjust: "107%",
        }),
      ).toThrow(/locally installed font/);
    }
  });

  it("keeps vendor keywords like -apple-system unquoted in the font stack", () => {
    const font = defineFont({
      family: "Inter",
      src: "/fonts/inter.woff2",
      fallbacks: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
    });
    expect(font.fontFamily).toBe(
      '"Inter", -apple-system, "BlinkMacSystemFont", "Segoe UI", sans-serif',
    );
  });

  it("trims fallback names and recognizes generic families case-insensitively", () => {
    const font = defineFont({
      family: "Inter",
      src: "/fonts/inter.woff2",
      fallbacks: [" Arial ", "Sans-Serif"],
      sizeAdjust: "107%",
    });
    expect(font.fontFamily).toContain('"Arial", Sans-Serif');
    expect(font.fallbackFaceCss).toContain('src:local("Arial")');
  });

  it("keeps semicolons and braces in family names inside the quoted CSS string", () => {
    const font = defineFont({
      family: "Foo;}@import url(evil);{",
      src: "/fonts/foo.woff2",
    });
    // The full rule stays intact: hostile characters are inert inside the
    // still-quoted string because the quote itself cannot be closed.
    expect(font.faceCss).toBe(
      '@font-face{font-family:"Foo;}@import url(evil);{";src:url("/fonts/foo.woff2") format("woff2");font-display:swap}',
    );
  });

  it("skips the fallback face when no metrics are provided", () => {
    const font = defineFont({
      family: "Inter",
      src: "/fonts/inter.woff2",
      fallbacks: ["Arial"],
    });
    expect(font.fallbackFaceCss).toBeUndefined();
    expect(font.fontFamily).toBe('"Inter", "Arial"');
  });

  it("supports multiple src variants with explicit formats", () => {
    const font = defineFont({
      family: "Custom",
      src: [{ url: "/fonts/custom.woff2" }, { url: "/fonts/custom.woff", format: "woff" }],
      style: "italic",
      weight: 700,
      display: "optional",
      unicodeRange: "U+0000-00FF, U+2192",
    });
    expect(font.faceCss).toBe(
      '@font-face{font-family:"Custom";src:url("/fonts/custom.woff2") format("woff2"), url("/fonts/custom.woff") format("woff");font-weight:700;font-style:italic;font-display:optional;unicode-range:U+0000-00FF, U+2192}',
    );
  });

  it("preloads only the first supported woff2 source when several variants are listed", () => {
    const font = defineFont({
      family: "Custom",
      src: [
        { url: "/fonts/custom.woff2" },
        { url: "/fonts/custom-alt.woff2" },
        { url: "/fonts/custom.woff", format: "woff" },
      ],
    });
    expect(font.preloadLinks).toEqual([
      {
        rel: "preload",
        as: "font",
        type: "font/woff2",
        href: "/fonts/custom.woff2",
        crossorigin: "anonymous",
      },
    ]);
  });

  it("falls back to preloading the first variant when no woff2 source exists", () => {
    const font = defineFont({
      family: "Legacy",
      src: [{ url: "/fonts/legacy.woff", format: "woff" }],
    });
    expect(font.preloadLinks).toEqual([
      {
        rel: "preload",
        as: "font",
        type: "font/woff",
        href: "/fonts/legacy.woff",
        crossorigin: "anonymous",
      },
    ]);
  });

  it("escapes CSS string metacharacters and markup in family names and urls", () => {
    const font = defineFont({
      family: 'Ev"il</style><script>',
      src: '/fonts/we"ird.woff2',
    });
    expect(font.faceCss).not.toContain("</style>");
    expect(font.faceCss).not.toContain("<script>");
    expect(font.faceCss).toContain('font-family:"Ev\\"il\\3c /style\\3e \\3c script\\3e "');
    expect(font.faceCss).toContain('src:url("/fonts/we\\"ird.woff2")');
  });

  it("rejects invalid descriptor values instead of interpolating them", () => {
    expect(() =>
      defineFont({ family: "X", src: "/f.woff2", weight: "400; } @import url(evil)" }),
    ).toThrow(/invalid weight/);
    expect(() => defineFont({ family: "X", src: "/f.woff2", style: "italic;}" })).toThrow(
      /invalid style/,
    );
    expect(() => defineFont({ family: "X", src: "/f.woff2", display: "swap;}" as never })).toThrow(
      /invalid display/,
    );
    expect(() =>
      defineFont({ family: "X", src: "/f.woff2", unicodeRange: "U+00?? } body{}" }),
    ).toThrow(/invalid unicodeRange/);
    expect(() => defineFont({ family: "X", src: "/f.woff2", sizeAdjust: "107% }" })).toThrow(
      /invalid sizeAdjust/,
    );
    expect(() => defineFont({ family: "X", src: "/f.woff2", sizeAdjust: "normal" })).toThrow(
      /invalid sizeAdjust/,
    );
    expect(
      defineFont({
        family: "X",
        src: "/f.woff2",
        fallbacks: ["Arial"],
        ascentOverride: "normal",
      }).fallbackFaceCss,
    ).toContain("ascent-override:normal");
    expect(() => defineFont({ family: "X", src: "/f.woff2 evil" })).toThrow(
      /whitespace or control characters/,
    );
    expect(() => defineFont({ family: "X", src: "/f\u0000.woff2" })).toThrow(
      /whitespace or control characters/,
    );
    expect(() => defineFont({ family: "", src: "/f.woff2" })).toThrow(/family/);
    expect(() => defineFont({ family: "X", src: [] })).toThrow(/src/);
  });

  it("rejects weights outside the CSS range and descending ranges", () => {
    // Grammar-valid but out-of-range values make browsers drop the descriptor
    // silently, so the face matches font-weight: normal instead.
    expect(() => defineFont({ family: "X", src: "/f.woff2", weight: 4000 })).toThrow(
      /between 1 and 1000/,
    );
    expect(() => defineFont({ family: "X", src: "/f.woff2", weight: 0 })).toThrow(
      /between 1 and 1000/,
    );
    expect(() => defineFont({ family: "X", src: "/f.woff2", weight: "900 100" })).toThrow(
      /ascending/,
    );
    expect(defineFont({ family: "X", src: "/f.woff2", weight: "100 900" }).faceCss).toContain(
      "font-weight:100 900",
    );
    expect(defineFont({ family: "X", src: "/f.woff2", weight: 1000 }).faceCss).toContain(
      "font-weight:1000",
    );
    expect(defineFont({ family: "X", src: "/f.woff2", weight: "auto" }).faceCss).toContain(
      "font-weight:auto",
    );
  });

  it("accepts CSS Fonts 4 styles and rejects invalid oblique angle ranges", () => {
    for (const style of ["auto", "left", "right", "oblique -10deg 20deg"]) {
      expect(defineFont({ family: "X", src: "/f.woff2", style }).faceCss).toContain(
        `font-style:${style}`,
      );
    }
    expect(() => defineFont({ family: "X", src: "/f.woff2", style: "oblique 120deg" })).toThrow(
      /between -90deg and 90deg/,
    );
    expect(() =>
      defineFont({ family: "X", src: "/f.woff2", style: "oblique 20deg 10deg" }),
    ).toThrow(/ascending/);
  });

  it("rejects unicode-range tokens that browsers treat as invalid", () => {
    // A single invalid token invalidates the whole descriptor, silently
    // widening the face to every code point.
    const bad = [
      "U+4?-FF",
      "U+?4",
      "U+110000",
      "U+??????",
      "U+11????",
      "U+00FF-0000",
      "U+0000-110000",
    ];
    for (const range of bad) {
      expect(() => defineFont({ family: "X", src: "/f.woff2", unicodeRange: range })).toThrow(
        /invalid unicodeRange/,
      );
    }
    const ok = defineFont({
      family: "X",
      src: "/f.woff2",
      unicodeRange: "U+0000-00FF, U+4??, u+10FFFF, U+10????",
    });
    expect(ok.faceCss).toContain("unicode-range:U+0000-00FF, U+4??, u+10FFFF, U+10????");
  });
});

describe("escapeCssString", () => {
  it("escapes quotes, backslashes, markup, and control characters", () => {
    expect(escapeCssString('a"b')).toBe('a\\"b');
    expect(escapeCssString("a\\b")).toBe("a\\\\b");
    expect(escapeCssString("a<b>c&d")).toBe("a\\3c b\\3e c\\26 d");
    expect(escapeCssString("a\nb")).toBe("a\\a b");
  });
});

describe("collectFontHeadFragments", () => {
  it("dedupes the same font registered multiple times", () => {
    const fragments = collectFontHeadFragments([inter, inter, inter]);
    expect(fragments.preloadLinks).toHaveLength(1);
    expect(fragments.css.match(/@font-face/g)).toHaveLength(2); // face + fallback face
    expect(fragments.css.match(/pracht-font-inter/g)).toHaveLength(1);
  });

  it("keeps distinct weights of the same family but collapses shared rules", () => {
    const regular = defineFont({
      family: "Inter",
      src: "/fonts/inter-regular.woff2",
      weight: 400,
      fallbacks: ["Arial"],
      sizeAdjust: "107%",
    });
    const bold = defineFont({
      family: "Inter",
      src: "/fonts/inter-bold.woff2",
      weight: 700,
      fallbacks: ["Arial"],
      sizeAdjust: "107%",
    });
    const fragments = collectFontHeadFragments([regular, bold]);
    expect(fragments.preloadLinks.map((link) => link.href)).toEqual([
      "/fonts/inter-regular.woff2",
      "/fonts/inter-bold.woff2",
    ]);
    // Two web-font faces, one shared fallback face, one shared class rule.
    expect(fragments.css.match(/@font-face/g)).toHaveLength(3);
    expect(fragments.css.match(/\.pracht-font-inter/g)).toHaveLength(1);
    expect(regular.className).toBe(bold.className);
  });

  it("drops CSS blocks from forged font objects that contain raw markup", () => {
    const forged = {
      ...inter,
      faceCss: "@font-face{}</style><script>alert(1)</script>",
      fallbackFaceCss: "</style><script>alert(2)</script>",
      classCss: ".x{}</style>",
      className: "x",
    };
    const fragments = collectFontHeadFragments([forged as never]);
    expect(fragments.css).toBe("");
    const html = buildHtmlDocument({ head: { fonts: [forged as never] }, body: "" });
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("alert(2)");
  });

  it("keeps every unicode-range subset of the same family/weight/style", () => {
    // The canonical self-hosted subset pattern: one @font-face per script
    // subset, identical family/weight/style, differing only in src and
    // unicode-range. Every subset must keep its own face — dropping one
    // while still preloading its file means a wasted download plus wrong
    // glyph rendering.
    const latin = defineFont({
      family: "Noto Sans",
      src: "/fonts/noto-latin.woff2",
      weight: "400",
      unicodeRange: "U+0000-00FF",
    });
    const cyrillic = defineFont({
      family: "Noto Sans",
      src: "/fonts/noto-cyrillic.woff2",
      weight: "400",
      unicodeRange: "U+0400-04FF",
    });
    const fragments = collectFontHeadFragments([latin, cyrillic]);
    expect(fragments.css).toContain("noto-latin.woff2");
    expect(fragments.css).toContain("noto-cyrillic.woff2");
    expect(fragments.css.match(/@font-face/g)).toHaveLength(2);
    expect(fragments.preloadLinks.map((link) => link.href)).toEqual([
      "/fonts/noto-latin.woff2",
      "/fonts/noto-cyrillic.woff2",
    ]);
    // Registering the same subsets again stays deduped.
    expect(collectFontHeadFragments([latin, cyrillic, latin]).css).toBe(fragments.css);
  });

  it("skips preloads for fonts registered with preload: false", () => {
    const font = defineFont({ family: "Quiet", src: "/fonts/quiet.woff2", preload: false });
    const fragments = collectFontHeadFragments([font]);
    expect(fragments.preloadLinks).toHaveLength(0);
    expect(fragments.css).toContain('font-family:"Quiet"');
  });
});

function makeRouteArgs(): BaseRouteArgs<unknown> {
  const request = new Request("https://example.com/");
  return {
    request,
    params: {},
    context: {},
    signal: new AbortController().signal,
    url: new URL(request.url),
    route: {} as BaseRouteArgs<unknown>["route"],
  };
}

describe("fonts through head merge and document rendering", () => {
  it("prefers a route font nonce over the shell nonce", async () => {
    const head = await mergeHeadMetadata(
      { Shell: () => null, head: () => ({ fontNonce: "shell" }) },
      { default: () => null, head: () => ({ fontNonce: "route" }) },
      makeRouteArgs(),
      undefined,
    );
    expect(head.fontNonce).toBe("route");
  });

  it("emits one preload and one @font-face when shell and route register the same font", async () => {
    const head = await mergeHeadMetadata(
      {
        Shell: () => null,
        head: () => ({ title: "Site", fonts: [inter] }),
      },
      {
        default: () => null,
        head: () => ({ title: "Page", fonts: [inter] }),
      },
      makeRouteArgs(),
      undefined,
    );
    expect(head.fonts).toHaveLength(2);

    const html = buildHtmlDocument({ head, body: "<p>hi</p>" });
    expect(html.match(/rel="preload" as="font"/g)).toHaveLength(1);
    expect(html.match(/@font-face\{font-family:"Inter";/g)).toHaveLength(1);
    expect(html.match(/<style data-pracht-fonts>/g)).toHaveLength(1);
  });

  it("renders every required preload attribute through the link allowlist", () => {
    const head: HeadMetadata = { fonts: [inter] };
    const html = buildHtmlDocument({ head, body: "" });
    expect(html).toContain(
      '<link data-pracht-font-preload rel="preload" as="font" type="font/woff2" href="/fonts/inter-latin.woff2" crossorigin="anonymous">',
    );
    expect(html).toContain("<style data-pracht-fonts>@font-face{");
    expect(html).toContain(`.${inter.className}{font-family:`);
  });

  it("adds a nonce to generated font CSS and keeps an empty nonce carrier", () => {
    const withFont = buildHtmlDocument({
      head: { fonts: [inter], fontNonce: 'nonce"value' },
      body: "",
    });
    expect(withFont).toContain('<style data-pracht-fonts nonce="nonce&quot;value">@font-face{');

    const carrier = buildHtmlDocument({ head: { fontNonce: "request-nonce" }, body: "" });
    expect(carrier).toContain('<style data-pracht-fonts nonce="request-nonce"></style>');
  });

  it("produces identical head output with and without hydration state", () => {
    const head: HeadMetadata = { fonts: [inter], title: "Static" };
    const withHydration = buildHtmlDocument({
      head,
      body: "<p>hi</p>",
      hydrationState: { url: "/", routeId: "home", data: null, error: null },
      clientEntryUrl: "/assets/entry.js",
    });
    const withoutHydration = buildHtmlDocument({ head, body: "<p>hi</p>" });
    const headOf = (html: string) => html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    expect(headOf(withHydration)).toBe(headOf(withoutHydration));
    expect(headOf(withoutHydration)).toContain("data-pracht-fonts");
  });

  it("never renders font CSS that could close the style element", () => {
    const evil = defineFont({
      family: 'Break"</style><script>alert(1)</script>',
      src: "/fonts/x.woff2",
    });
    const html = buildHtmlDocument({ head: { fonts: [evil] }, body: "" });
    expect(html).not.toContain("<script>alert(1)</script>");
    const styleStart = html.indexOf("<style data-pracht-fonts>");
    const styleEnd = html.indexOf("</style>");
    expect(styleStart).toBeGreaterThan(-1);
    // The first </style> in the document is the closing tag of the font style
    // element itself, not attacker-controlled content.
    expect(html.slice(styleStart, styleEnd)).not.toContain("</style");
  });
});
