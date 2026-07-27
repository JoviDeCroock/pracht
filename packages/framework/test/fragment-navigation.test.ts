// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeFragmentId,
  findFragmentTarget,
  focusFragmentTarget,
  scrollToFragmentTarget,
} from "../src/fragment-navigation.ts";

describe("fragment navigation helpers", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  describe("decodeFragmentId", () => {
    it("strips the leading # and percent-decodes the id", () => {
      expect(decodeFragmentId("#section")).toBe("section");
      expect(decodeFragmentId("section")).toBe("section");
      expect(decodeFragmentId("#%C3%BCberblick")).toBe("überblick");
    });

    it("returns an empty id for an empty fragment", () => {
      expect(decodeFragmentId("#")).toBe("");
      expect(decodeFragmentId("")).toBe("");
    });

    it("keeps a malformed encoding verbatim rather than throwing", () => {
      expect(decodeFragmentId("#100%")).toBe("100%");
    });
  });

  describe("findFragmentTarget", () => {
    it("resolves an element by its decoded id", () => {
      document.body.innerHTML = `<h2 id="überblick">Überblick</h2>`;
      expect(findFragmentTarget(document, "#%C3%BCberblick")?.id).toBe("überblick");
    });

    it("returns null for an empty or unresolvable fragment", () => {
      document.body.innerHTML = `<h2 id="here">here</h2>`;
      expect(findFragmentTarget(document, "#")).toBeNull();
      expect(findFragmentTarget(document, "#missing")).toBeNull();
    });
  });

  describe("focusFragmentTarget", () => {
    it("focuses a non-focusable target through a temporary tabindex", () => {
      document.body.innerHTML = `<main id="main">content</main>`;
      const main = document.getElementById("main")!;

      focusFragmentTarget(main);

      expect(document.activeElement).toBe(main);
      expect(main.getAttribute("tabindex")).toBe("-1");
    });

    it("removes the temporary tabindex again on blur", () => {
      document.body.innerHTML = `<main id="main">content</main><a id="next" href="/">next</a>`;
      const main = document.getElementById("main")!;

      focusFragmentTarget(main);
      expect(main.getAttribute("tabindex")).toBe("-1");

      document.getElementById("next")!.focus();

      expect(main.hasAttribute("tabindex")).toBe(false);
      expect(main.hasAttribute("data-pracht-fragment-tabindex")).toBe(false);
    });

    it("leaves a natively focusable target's attributes alone", () => {
      document.body.innerHTML = `<a id="target" href="/somewhere">target</a>`;
      const target = document.getElementById("target")!;

      focusFragmentTarget(target);

      expect(document.activeElement).toBe(target);
      expect(target.hasAttribute("tabindex")).toBe(false);
    });

    it("does not clobber an author-provided tabindex", () => {
      document.body.innerHTML = `<div id="target" tabindex="0">target</div>`;
      const target = document.getElementById("target")!;

      focusFragmentTarget(target);

      expect(target.getAttribute("tabindex")).toBe("0");

      // Blur must not strip an attribute the route authored.
      target.dispatchEvent(new FocusEvent("blur"));
      expect(target.getAttribute("tabindex")).toBe("0");
    });

    it("focuses without scrolling, leaving scroll behavior to the caller", () => {
      document.body.innerHTML = `<main id="main">content</main>`;
      const main = document.getElementById("main")!;
      const focusSpy = vi.spyOn(main, "focus");

      focusFragmentTarget(main);

      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    });
  });

  describe("scrollToFragmentTarget", () => {
    it("scrolls with no behavior option so CSS scroll-behavior decides", () => {
      document.body.innerHTML = `<h2 id="section">section</h2>`;
      const target = document.getElementById("section")!;
      const scrollIntoView = vi.fn();
      target.scrollIntoView = scrollIntoView;

      scrollToFragmentTarget(target);

      expect(scrollIntoView).toHaveBeenCalledWith();
      expect(document.activeElement).toBe(target);
    });

    it("still focuses when scrollIntoView is unavailable", () => {
      document.body.innerHTML = `<h2 id="section">section</h2>`;
      const target = document.getElementById("section")!;
      // jsdom does not implement scrollIntoView unless a test provides it.
      (target as { scrollIntoView?: unknown }).scrollIntoView = undefined;

      expect(() => scrollToFragmentTarget(target)).not.toThrow();
      expect(document.activeElement).toBe(target);
    });
  });
});
