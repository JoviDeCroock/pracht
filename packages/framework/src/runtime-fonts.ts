import type { FontHeadFragments } from "./font.ts";

/** Replace the generated font registrations owned by the active route. */
export function applyFontHeadFragments(fontHead: FontHeadFragments): void {
  for (const link of document.head.querySelectorAll("link[data-pracht-font-preload]")) {
    link.remove();
  }
  for (const descriptor of fontHead.preloadLinks) {
    const link = document.createElement("link");
    link.dataset.prachtFontPreload = "";
    for (const name of ["rel", "as", "type", "href", "crossorigin"] as const) {
      const value = descriptor[name];
      if (typeof value === "string") link.setAttribute(name, value);
    }
    document.head.appendChild(link);
  }

  const existing = document.head.querySelector<HTMLStyleElement>("style[data-pracht-fonts]");
  if (existing) {
    existing.textContent = fontHead.css;
    if (!fontHead.css && !existing.nonce) existing.remove();
  } else if (fontHead.css) {
    const style = document.createElement("style");
    style.dataset.prachtFonts = "";
    style.textContent = fontHead.css;
    document.head.appendChild(style);
  }
}
